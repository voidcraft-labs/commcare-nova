// lib/domain/predicate/typeChecker.ts
//
// Schema-driven type checker for the predicate AST. `checkPredicate(p,
// ctx)` walks a Predicate against a TypeContext (the blueprint's
// CaseType schema and the search inputs in scope) and produces either
// Ok or a list of typed errors with paths so the editor can highlight
// the offending card without having to reparse the AST itself.
//
// Why a separate type-check pass from `predicateSchema.parse(...)`: the
// Zod schema enforces structural validity (the AST is well-formed) but
// not semantic validity. Semantic checks require the blueprint's
// `CaseType` schema as a side input — they can't be encoded in the AST
// schema itself, which knows nothing about which case types exist. The
// split keeps the AST schema independent of any particular blueprint
// and concentrates the schema-driven rules in this one walker.
//
// Coverage is per-operator and intentionally not uniform across kinds.
// Term resolution (referenced property exists on the named case type,
// named search input is declared, session-user / session-context refs
// and literals resolve to their data type) runs uniformly across every operator
// that carries term operands — comparisons, the trigger-input slot of
// `when-input-present`, and the term operands of `in` /
// `within-distance` / `match` / `multi-select-contains` / `is-null` /
// `is-blank` / `between`. Operand-type compatibility (the "comparable
// types" check between resolved operand types) runs for the comparison
// operators (`eq` / `neq` / `gt` / `gte` / `lt` / `lte`), `in`'s and
// `multi-select-contains`'s membership values, and `between`'s
// per-bound check against `left`. Per-operator semantic checks beyond
// resolution + compatibility run in dedicated arms: `within-distance`
// requires the `property` slot to resolve to `geopoint` and the
// `center` slot to resolve to `geopoint` or `text` (the wire-form
// coordinate string is text); `match` requires the `property` slot
// to resolve to one of the text-shaped data types (`text` /
// `single_select` / `multi_select`) across all four modes;
// `multi-select-contains` requires the `property` slot to resolve
// to `multi_select` specifically (a Nova authoring policy stricter
// than CCHQ's wire-layer dispatch — see `checkMultiSelectContains`
// for the rationale); `is-null` / `is-blank` accept any non-literal
// Term in `left` and reject literal-shaped `left` as a category
// error (a literal is the value itself, not a runtime read whose
// presence is in question — see `checkAbsenceOperator` for the
// rationale and the spec subsection "Null vs blank semantics" under
// the Predicate family); `between` requires `left` and any provided
// bounds to resolve to one of the ordered types and detects literal-
// pair `lower > upper` impossibility (see `checkBetween`); `exists` /
// `missing` walk `via` to a destination case type and recursively
// type-check `where` (if present) in that destination scope, with
// `prop.caseType` inside the where-clause pinned to the destination
// scope (see `checkRelationalQuantifier` and `checkRelationPath`).
// Logical wrappers (`and` / `or` / `not`) and the wrapped clause of
// `when-input-present` recurse so violations inside them surface
// here, with paths threading the operator name and (for the multi-
// clause arms) the array index.

import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import { unhandledKindMessage } from "./errors";
import type {
	ArithOp,
	ComparisonKind,
	DateAddInterval,
	Literal,
	MatchMode,
	Predicate,
	RelationPath,
	Term,
	ValueExpression,
} from "./types";

// ---------- Types ----------

/**
 * Declared search input in scope at the type-check site. The case-search
 * UI declares inputs at the screen level; predicates referencing
 * `input(name)` resolve against this list. The optional `data_type`
 * widens or narrows the comparison-rule check at this input's use site
 * — when omitted, the input defaults to `text`, which is CommCare's
 * default for properties without an explicit type.
 *
 * Distinct from the AST `SearchInputRef` (the `input("name")` term
 * built by the predicate). `SearchInputRef` is on the predicate side
 * and discriminates with `kind: "input"` to participate in the
 * `Term` discriminated union; `SearchInputDecl` is on the context
 * side and is looked up by `name` only, so it carries no
 * discriminator.
 */
export type SearchInputDecl = {
	name: string;
	data_type?: CasePropertyDataType;
};

/**
 * The schema-derived context the checker validates a predicate against.
 * Composed at the call site from the blueprint (`caseTypes`), the
 * search-screen's declared inputs (`knownInputs`), and the originating
 * case-type scope the predicate runs against (`currentCaseType`).
 *
 * Property references carry their own `caseType` qualifier on
 * `PropertyRef` — naming the originating scope, per the contract on
 * `propertyRefSchema.caseType` — so resolution against `caseTypes` is
 * driven by the term itself rather than any "current" anchor at the
 * walker.
 *
 * `currentCaseType` is required only by the relational quantifiers
 * (`exists` / `missing`) and by the destination-scope pin inside their
 * `where` clauses. At the top level it identifies the case type the
 * predicate runs against — i.e., where an `ancestor` walk starts and
 * what an `exists(self)` would mean. Inside a `where` clause it tracks
 * the destination of the surrounding `via`, used by `walk` →
 * `checkInDestinationScope` to enforce `prop.caseType ===
 * currentCaseType` when set. The slot is optional at the type layer
 * so call sites that exercise no relational features (the
 * comparison / membership / absence tests) compose the context as
 * `{ caseTypes, knownInputs }` literally and the field stays absent
 * without a value-construction step. The case-list config UI
 * supplies it when invoking the checker against the relational
 * surface.
 *
 * The prop.caseType-vs-currentCaseType pin in `resolveTermType` gates
 * on `currentCaseType !== undefined` — when absent, every property
 * reference resolves on its own qualifier with no destination-scope
 * constraint applied. When present, the constraint enforces the
 * destination-scope contract the spec locks at the `where`-clause
 * boundary.
 */
export type TypeContext = {
	caseTypes: CaseType[];
	knownInputs: SearchInputDecl[];
	currentCaseType?: string;
};

/**
 * Path locating where in the predicate AST a CheckError occurred.
 * Consumers walk the AST in parallel with the path to land on the
 * offending node — at each step the consumer knows the current
 * operator from the AST, so the path encodes only "which slot or
 * which child" at each level.
 *
 * Segments come in two shapes, one per operator family:
 *
 *   1. Recursive wrappers — `and`, `or`, `not`, `when-input-present`
 *      — push their `kind` first, then either an array index
 *      (`and` / `or`) or a slot name (`not` → `["not", "clause"]`,
 *      `when-input-present` →
 *      `["when-input-present", "input" | "clause"]`). Nested errors
 *      accumulate operator names as the walker descends, so
 *      `["and", 0, "or", 1, "not", "clause", "left"]` means "the
 *      left operand of the comparison wrapped by `not`, which is
 *      the second clause of the `or`, which is the first clause of
 *      the `and`." Recursive wrappers carry their kind because their
 *      operands are themselves predicates that can recursively emit
 *      paths — without the kind segment, an error from inside a
 *      nested `or` would be indistinguishable from one in a sibling
 *      `and`.
 *
 *   2. Leaf-like operators — comparisons, `in`, `within-distance`,
 *      `match`, `multi-select-contains` — push only the operand slot
 *      name (`left`, `right`, `property`, `center`, `values`). Their
 *      operands are terms, not nested predicates, so paths don't
 *      accumulate operator names through descent. The parent's path
 *      already disambiguates which operator the slot belongs to: a
 *      consumer walking the AST in parallel knows the current
 *      operator at every level.
 *
 * Operator-level errors (e.g. "Operator 'gt' requires ordered
 * types") attach to the predicate's own path with no slot suffix, so
 * a top-level `gt` failing the ordered check carries `path: []`.
 */
export type CheckPath = (string | number)[];
export type CheckError = { path: CheckPath; message: string };

export type CheckResult = { ok: true } | { ok: false; errors: CheckError[] };

/**
 * Sentinel for the `null` literal — comparable against any declared
 * property type. Authors writing
 * `eq(prop("patient", "age"), literal(null))` are asking "is this
 * property unset", which is a valid predicate at every wire target;
 * resolving the null literal to a concrete data type would force a
 * spurious type-mismatch error every time. The sentinel short-circuits
 * both the ordered-types check in `checkComparison` and the
 * compatibility table in `typesCompatible`.
 *
 * Visibility: this sentinel is exported because every value-bearing
 * surface — `checkPredicate`, `checkExpression`, the per-operator
 * helpers in this file — routes through the same null-as-universal
 * compatibility rule. The sentinel is NOT a user-facing surface — it
 * never appears in `CheckError.message` (the `describe(...)` helper
 * renders it as `"null"`) and it never reaches the AST (literals
 * carry their source value `null`, not the sentinel). External
 * callers that surface resolved types in messages MUST route through
 * `describe(...)` for the same reason.
 */
export const ANY_TYPE = "_any" as const;

/**
 * Sentinel for the sequence type produced by `unwrap-list`. Marks a
 * value resolved from CSQL's `unwrap-list(...)` value function — a
 * JSON-encoded array surfaced as a sequence of values. v1 has no
 * AST consumer for the sequence type — `in.values` and
 * `multi-select-contains.values` stay literal-only because every
 * wire target demands a static value list — but the type checker
 * needs a defined verdict for the `unwrap-list` arm so callers can
 * compose ASTs that include it (the consuming wire pattern is
 * `selected-any(prop, unwrap-list(...))` in the CSQL emitter, which
 * the representability checker routes through).
 *
 * Like `ANY_TYPE`, the sentinel is internal-only. The
 * compatibility table treats sequences as incompatible with every
 * scalar type, including itself — there's no v1 operator that
 * combines two sequences semantically. A future operator that
 * accepts a sequence (e.g. `multi-select-contains` widening to
 * accept a `ValueExpression` candidate list at the wire boundary)
 * will route through a dedicated check rather than relying on the
 * scalar compatibility table.
 */
export const SEQUENCE_TYPE = "_sequence" as const;

/**
 * Resolved type for any value-bearing surface — a
 * `CasePropertyDataType` for declared properties, `ANY_TYPE` for
 * null-literal compatibility, `SEQUENCE_TYPE` for `unwrap-list`-
 * produced sequences.
 *
 * Every value-bearing surface (`resolveTermType`, `checkExpression`,
 * `literalType`) routes through this alphabet so the compatibility
 * widening rules (numeric promotion, select-to-text, null-as-
 * universal) carry over uniformly. Public callers that surface a
 * resolved type in user-facing strings route through `describe(...)`
 * so the internal sentinels render as friendly names.
 */
export type ResolvedType =
	| CasePropertyDataType
	| typeof ANY_TYPE
	| typeof SEQUENCE_TYPE;

/**
 * Data types whose values support a total order — `gt`/`gte`/`lt`/`lte`
 * accept only operands drawn from this set. Strings (text) are
 * deliberately excluded: while string comparison is technically defined
 * at every wire target, locale-dependent string ordering is rarely
 * meaningful for case-list filtering and ordering on names tends to
 * surprise authors. Forcing the author to pick a different operator (a
 * fuzzy match, a starts-with comparison, etc.) is preferable to
 * silently emitting a lexicographic compare.
 */
export const ORDERED_TYPES: ReadonlySet<ResolvedType> = new Set<ResolvedType>([
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
]);

// Match-mode allow-lists.
//
// CCHQ's underlying Elasticsearch index stores every case property's
// value as text on the `PROPERTY_VALUE` field
// (`commcare-hq/corehq/apps/es/case_search.py:50`, defined as
// `f'{CASE_PROPERTIES_PATH}.{VALUE}'`), so the wire layer accepts
// every match mode against any property regardless of declared type.
// The Nova type checker is stricter: each mode has a per-mode allow-
// list, rejecting property types where the mode's semantics produce
// no useful results.
//
// Three of the four modes — `fuzzy`, `phonetic`, `starts-with` — match
// by approximate-string semantics (edit-distance, phonetic
// equivalence, prefix matching). Those metrics are defined on
// character strings, not on numeric / temporal / coordinate values, so
// the allow-list narrows to text-shaped properties. Per-mode CCHQ
// dispatch:
//
//   - `fuzzy-match` (`commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:92-98`)
//     calls `case_property_query(..., fuzzy=True)`.
//   - `phonetic-match` (`query_functions.py:84-89`) calls
//     `sounds_like_text_query` (`case_search.py:305`).
//   - `starts-with` (`query_functions.py:31-35`) calls
//     `case_property_starts_with` (`case_search.py:312-323`), a prefix
//     match on `PROPERTY_VALUE_EXACT`.
//
// `fuzzy-date` (`query_functions.py:101-113`) is special. It builds
// digit-permutation candidates from the input via `date_permutations`
// and matches them against the same `PROPERTY_VALUE` text field via
// `case_property_query(..., boost_first=True)`. The operator is
// specifically designed to recover from transposed YYYY-MM-DD input
// against date-typed properties — narrowing it to text-only would
// force authors to declare dates as text to use the operator, which
// defeats the typed-property model the blueprint already establishes
// (typed `date` / `datetime` literals via `dateLiteral` /
// `datetimeLiteral` in `builders.ts`). So `fuzzy-date` widens the
// allow-list to include `date` and `datetime` in addition to the
// text-shaped trio.
//
// Why text-shaped types — `text`, `single_select`, `multi_select` —
// pass every mode's allow-list: on CCHQ's wire, single-select values
// serialize as plain strings and multi-select values as space-
// separated strings in the same `PROPERTY_VALUE` field text uses, so
// each match mode reaches the same Elasticsearch mechanism whether
// the underlying property is text or a select kind.
const MATCH_PROPERTY_TYPES_TEXT_SHAPED: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>(["text", "single_select", "multi_select"]);
const MATCH_PROPERTY_TYPES_FUZZY_DATE: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>([
		"text",
		"single_select",
		"multi_select",
		"date",
		"datetime",
	]);

// Per-mode allow-list lookup. `Record<MatchMode, ...>` is exhaustive at
// the type layer: adding a fifth match mode without an entry here is a
// compile-time error rather than a silent fall-through to the default
// allow-list. The `as const` shape on `MATCH_MODES` makes the
// `MatchMode` union the closed key set, so this Record can't admit a
// stray key. Keying by mode also makes the per-mode dispatch readable
// at a glance — every mode's allow-list is one row in this table
// rather than chained ternaries.
const MATCH_PROPERTY_TYPES_BY_MODE: Record<
	MatchMode,
	ReadonlySet<ResolvedType>
> = {
	fuzzy: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	phonetic: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	"fuzzy-date": MATCH_PROPERTY_TYPES_FUZZY_DATE,
	"starts-with": MATCH_PROPERTY_TYPES_TEXT_SHAPED,
};

// ---------- Top-level walker ----------

/**
 * Validate a predicate against the supplied context. Pure — no I/O, no
 * side effects, the input AST is never mutated. Errors accumulate
 * across the whole walk so the editor can surface every issue in one
 * pass rather than forcing the author through one-error-at-a-time
 * fix-and-retry cycles.
 *
 * Every kind in the `Predicate` discriminated union has a dedicated
 * semantic rule (no throw arms). Adding a new kind without a parallel
 * arm in `walk` is a TypeScript compile error via the exhaustiveness
 * assertion at the bottom of the switch — the runtime throw guards
 * untyped boundaries that bypass the type system.
 */
export function checkPredicate(
	predicate: Predicate,
	ctx: TypeContext,
): CheckResult {
	const errors: CheckError[] = [];
	walk(predicate, ctx, errors, []);
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Recursive dispatch on the predicate's discriminator. Comparison
 * operators run their dedicated check; logical wrappers recurse into
 * their child predicates so a violation buried inside an `and` / `or` /
 * `not` / `when-input-present` wrapper surfaces with a precise path.
 * The exhaustiveness assertion in `default:` forces every new operator
 * added to `Predicate` to either get its own arm here or be explicitly
 * forwarded — silent miscompilation (a new kind silently bypassing all
 * checks) is impossible.
 */
function walk(
	p: Predicate,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	switch (p.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			checkComparison(p.kind, p.left, p.right, ctx, errors, path);
			return;
		case "and":
		case "or":
			// Each clause path is `[...path, kind, index]` so the editor
			// can disambiguate a clause inside `and(...)` from a clause
			// inside a sibling `or(...)`. The kind segment also signals
			// to the path consumer that the next number is an array index.
			// Indexed for-loop so the path threads through the array index
			// without detouring through forEach.
			for (let i = 0; i < p.clauses.length; i++) {
				walk(p.clauses[i], ctx, errors, [...path, p.kind, i]);
			}
			return;
		case "not":
			// Path convention: `[operator-name, field-name]` for unary
			// wrappers — same shape as `when-input-present` below — so
			// every wrapping operator's path segment uniformly identifies
			// "the operator" then "the slot inside it."
			walk(p.clause, ctx, errors, [...path, p.kind, "clause"]);
			return;
		case "when-input-present":
			// Resolve the trigger input through the same path the
			// comparison operators use for their `input(...)` operands —
			// produces the same "Unknown search input '<name>'." error
			// shape and lets the editor highlight the trigger card the
			// same way it highlights any other unresolved input. Without
			// this check, an undeclared trigger silently passes: the
			// wrapped clause type-checks fine, the trigger never resolves
			// at runtime, and the predicate becomes a permanent no-op.
			resolveTermType(p.input, ctx, errors, [...path, p.kind, "input"]);
			walk(p.clause, ctx, errors, [...path, p.kind, "clause"]);
			return;
		case "in":
			checkIn(p, ctx, errors, path);
			return;
		case "within-distance":
			checkWithinDistance(p, ctx, errors, path);
			return;
		case "match":
			checkMatch(p, ctx, errors, path);
			return;
		case "multi-select-contains":
			checkMultiSelectContains(p, ctx, errors, path);
			return;
		case "match-all":
		case "match-none":
			// Discriminator-only sentinels — no operands, no operator-
			// specific semantic rule to defer. By construction these
			// are well-typed: the schema admits exactly the shape
			// `{ kind }` and there is nothing to validate beyond that.
			// The walker accepts them silently and recurses no further
			// (they have no children). This arm is reachable via
			// composition (`and(matchAll(), eq(...))` walks `and` →
			// recurses into `matchAll`); a throw here would crash any
			// composed predicate that includes a sentinel.
			return;
		case "is-null":
		case "is-blank":
			// `is-null` (strict-absent) and `is-blank` (absent-or-empty)
			// share one rule shape at this layer: every non-literal Term
			// variant is accepted (any property / input / session ref
			// can resolve to absent at runtime) and literal-shaped
			// `left` is rejected as a category error. A literal is the
			// value itself; "is the literal 5 absent" / "is the literal
			// 5 blank" is ill-formed, not a runtime question. The two
			// operators diverge only at per-dialect emission (Postgres
			// / in-memory distinguishes the strict semantic; CCHQ wire
			// collapses the two states), which is irrelevant to type-
			// checking — the operand-shape question is identical at
			// this layer. Spec subsection: "Null vs blank semantics"
			// under the Predicate family in
			// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`.
			checkAbsenceOperator(p, ctx, errors, path);
			return;
		case "between":
			checkBetween(p, ctx, errors, path);
			return;
		case "exists":
		case "missing":
			// `exists` and `missing` share one rule shape — both walk
			// their `via` to a destination case type and recursively
			// type-check the optional `where` clause in that destination
			// scope. The two operators diverge only at per-dialect wire
			// emission (`missing` is sugar for `not(exists(...))`), which
			// is irrelevant to type-checking. Spec subsection: "Relation
			// paths" and the `exists`/`missing` arms of the Predicate
			// family in
			// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`.
			checkRelationalQuantifier(p, ctx, errors, path);
			return;
		default: {
			// Exhaustiveness assertion — adding a new kind to `Predicate`
			// without a parallel arm here breaks the build. The runtime
			// throw guards the same invariant for any payload that reaches
			// this branch via untyped boundaries.
			const _exhaustive: never = p;
			throw new Error(
				unhandledKindMessage({
					where: "checkPredicate",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"and",
						"or",
						"not",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"multi-select-contains",
						"match",
						"within-distance",
						"exists",
						"missing",
						"when-input-present",
						"is-null",
						"is-blank",
					],
				}),
			);
		}
	}
}

// ---------- Comparison checking ----------

/**
 * Apply the comparison-operand rules:
 *   1. Both operands' types must resolve. If either operand fails to
 *      resolve (e.g. unknown property, unknown input, ill-typed
 *      arithmetic), `checkExpression` pushes the failure on the
 *      operand's own path and returns `undefined`. We bail before the
 *      compatibility check so the author isn't bombarded with a
 *      cascading "type mismatch" error on top of the real one.
 *   2. For ordering operators (`gt`/`gte`/`lt`/`lte`), both sides must
 *      be in `ORDERED_TYPES` (or be the `_any` null-sentinel). Strings,
 *      selects, and geopoints are explicitly rejected — see
 *      `ORDERED_TYPES`'s JSDoc for why.
 *   3. The two resolved types must be comparable per `typesCompatible`.
 *      The compatibility table widens a small set of pairs (numeric
 *      promotion, select-to-text, null-to-anything) to keep the type
 *      checker out of the author's way for the most common shapes;
 *      everything else fails.
 *
 * The verdict from rules 2 and 3 attaches to the predicate's own path
 * (`path`), not the operand's (`[...path, "left"]`). The author thinks
 * "this comparison is wrong," not "the right operand of this
 * comparison is wrong" — the comparison-level error is the more
 * actionable framing, and the operand-resolution errors above already
 * carry their own per-side paths when the failure is operand-local.
 *
 * Operands are `ValueExpression` post-widen — comparisons can take
 * arithmetic / conditional / count-aggregation expressions as well as
 * the term-shaped operands the auto-wrap admits. The operand
 * resolution dispatches into `checkExpression`, which short-circuits
 * to `resolveTermType` for the `term` arm.
 */
function checkComparison(
	kind: ComparisonKind,
	left: ValueExpression,
	right: ValueExpression,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = checkExpression(left, ctx, errors, [...path, "left"]);
	const rightType = checkExpression(right, ctx, errors, [...path, "right"]);
	if (leftType === undefined || rightType === undefined) return;

	if (kind !== "eq" && kind !== "neq") {
		// `_any` (the null sentinel) bypasses the ordered-types check —
		// `gt(prop, literal(null))` is meaningless but treated as "type
		// is compatible, evaluator handles the null-coercion at runtime"
		// rather than a type-checker rejection.
		const leftOrdered = leftType === ANY_TYPE || ORDERED_TYPES.has(leftType);
		const rightOrdered = rightType === ANY_TYPE || ORDERED_TYPES.has(rightType);
		if (!leftOrdered || !rightOrdered) {
			errors.push({
				path,
				message: `Operator '${kind}' requires ordered types (int, decimal, date, datetime, time); got '${describe(leftType)}' and '${describe(rightType)}'. Strings are not ordered.`,
			});
			return;
		}
	}

	if (!typesCompatible(leftType, rightType)) {
		errors.push({
			path,
			message: `Type mismatch: '${describe(leftType)}' and '${describe(rightType)}' are not comparable.`,
		});
	}
}

/**
 * Render a `ResolvedType` for inclusion in a user-facing error message.
 * Hides the internal sentinels — `_any` (null) and `_sequence` (the
 * `unwrap-list`-produced sequence) appear under their friendly names
 * (`"null"` / `"sequence"`) since the internal underscored names
 * don't appear anywhere in the author's source.
 */
export function describe(t: ResolvedType): string {
	if (t === ANY_TYPE) return "null";
	if (t === SEQUENCE_TYPE) return "sequence";
	return t;
}

// ---------- Per-operator semantic checks ----------
//
// `in`, `within-distance`, `match`, and `multi-select-contains` each
// carry an operator-specific rule beyond term resolution and the
// comparison-level compatibility table. Each helper is responsible
// for both resolving its operands (so unknown-property / unknown-input
// errors surface uniformly with comparisons) and applying the rule's
// semantic constraint. Helpers operate on the `Predicate` arm directly
// so the operand slot names in error paths come from the AST shape,
// not from a string the helper invents.
//
// `when-input-present` has no semantic constraint beyond
// trigger-input resolution and clause recursion — both performed
// inline in the walker — so it has no helper here.

/**
 * Membership compatibility check for `in`. Each value in `values` is
 * checked against `left`'s resolved type via the same `typesCompatible`
 * table that comparison operators use. Sharing the table is a Nova
 * design choice — the same widenings (numeric promotion,
 * select-to-text, null-as-universal) carry over to membership so
 * authors don't relearn compatibility per operator.
 *
 * If `left` fails to resolve (unknown property, unknown input), the
 * resolution error is already pushed onto `path/left` by
 * `resolveTermType`; the early return prevents a cascade of "type
 * mismatch" errors from each value in the list once the left side is
 * already broken.
 *
 * Errors per offending value carry their index so the editor highlights
 * each failing chip independently. Accumulating rather than
 * short-circuiting matches the comparison-level "every error in one
 * pass" contract — the editor surfaces the full set in one render.
 */
function checkIn(
	p: Extract<Predicate, { kind: "in" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = checkExpression(p.left, ctx, errors, [...path, "left"]);
	if (leftType === undefined) return;
	for (let i = 0; i < p.values.length; i++) {
		const valType = literalType(p.values[i]);
		if (!typesCompatible(leftType, valType)) {
			errors.push({
				path: [...path, "values", i],
				message: `Type mismatch: literal '${describe(valType)}' is not comparable with property type '${describe(leftType)}'.`,
			});
		}
	}
}

/**
 * Property + center type check for `within-distance`. The property
 * slot must resolve to `geopoint` because CCHQ's
 * `case_property_geo_distance` (corehq/apps/es/case_search.py:386)
 * queries the `PROPERTY_GEOPOINT_VALUE` field — only properties stored
 * as a geopoint participate in the geo-distance query. The center
 * slot's allow-list is `geopoint | text`: a typed-geopoint search
 * input is the natural shape, but CCHQ also accepts a wire-form
 * coordinate string (`"lat lon altitude accuracy"`, parsed via
 * `GeoPoint.from_string(..., flexible=True)` at
 * corehq/apps/case_search/xpath_functions/query_functions.py:60),
 * which carries through Nova's pipeline as a `text`-typed literal.
 *
 * Both operands resolve unconditionally (no early return on
 * property-side failure) so the editor surfaces every per-operand
 * error in one pass. If property-side resolution fails entirely
 * (unknown property), the resolution error already covers it; the
 * additional geopoint-requirement error only fires when resolution
 * succeeds and the resolved type is non-geopoint.
 */
function checkWithinDistance(
	p: Extract<Predicate, { kind: "within-distance" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	// `property` stays a `PropertyRef` — the wire-side dispatch keys
	// off the property name, so widening this slot to a value expression
	// has no wire target. Resolve via `resolveTermType` directly.
	const propType = resolveTermType(p.property, ctx, errors, [
		...path,
		"property",
	]);
	if (propType !== undefined && propType !== "geopoint") {
		errors.push({
			path: [...path, "property"],
			message: `within-distance requires a geopoint property; got '${describe(propType)}'.`,
		});
	}
	// `center` widens to `ValueExpression` — resolve via
	// `checkExpression` so a coalesce-derived or arithmetic-derived
	// coordinate string can drive the geo predicate alongside the
	// natural search-input / session-user shapes.
	const centerType = checkExpression(p.center, ctx, errors, [
		...path,
		"center",
	]);
	if (
		centerType !== undefined &&
		centerType !== "geopoint" &&
		centerType !== "text"
	) {
		errors.push({
			path: [...path, "center"],
			message: `within-distance center must resolve to a geopoint or a text-encoded coordinate string; got '${describe(centerType)}'.`,
		});
	}
}

/**
 * Property-type requirement on `match.property`, branched per mode.
 *
 * Three of the four modes (`fuzzy` / `phonetic` / `starts-with`) use
 * the text-shaped allow-list — `text` / `single_select` /
 * `multi_select`. Each mode's CCHQ dispatch reaches the
 * `PROPERTY_VALUE` Elasticsearch field, which stores every property's
 * value as text regardless of declared type, but Nova narrows to the
 * text-shaped trio because edit-distance, phonetic equivalence, and
 * prefix matching produce no useful results against numeric /
 * temporal / coordinate values.
 *
 * `fuzzy-date` widens the allow-list to additionally accept `date` and
 * `datetime` properties. CCHQ's `fuzzy_date` is specifically designed
 * to recover from transposed YYYY-MM-DD inputs against date-typed
 * properties; narrowing it to text-only would force authors to
 * declare dates as text to use the operator, which defeats the
 * typed-property model the blueprint already establishes (typed
 * `date` / `datetime` literals via `dateLiteral` / `datetimeLiteral`
 * in `builders.ts`).
 *
 * See `MATCH_PROPERTY_TYPES_TEXT_SHAPED` /
 * `MATCH_PROPERTY_TYPES_FUZZY_DATE` above for the per-mode CCHQ
 * citations and full rationale.
 */
function checkMatch(
	p: Extract<Predicate, { kind: "match" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const propType = resolveTermType(p.property, ctx, errors, [
		...path,
		"property",
	]);
	// `Record<MatchMode, ...>` indexed-access guarantees a defined
	// allow-list for every mode at compile time — adding a mode without
	// a `MATCH_PROPERTY_TYPES_BY_MODE` entry is a TS error, so the
	// dispatch is exhaustive without a runtime `default: never` arm.
	const allowList = MATCH_PROPERTY_TYPES_BY_MODE[p.mode];
	// `ANY_TYPE` is structurally unreachable for a `PropertyRef` today,
	// but the explicit guard pins the invariant at the type system: a
	// future widening of the match schema's operand or of
	// `resolveTermType`'s null handling fails the
	// `CasePropertyDataType`-typed `has` lookup at compile time
	// instead of silently treating `_any` as "passes the allow-list."
	if (
		propType !== undefined &&
		propType !== ANY_TYPE &&
		!allowList.has(propType)
	) {
		// Sort the allow-list for stable error output regardless of
		// iteration order — Set iteration order is insertion order in
		// V8, but pinning it avoids any future divergence between
		// Node versions or alternative runtimes.
		const allowed = [...allowList].sort().join(", ");
		errors.push({
			path: [...path, "property"],
			message: `match mode='${p.mode}' requires a property of type ${allowed}; got '${describe(propType)}'.`,
		});
	}
	// `value` is a widened `ValueExpression` (per `matchSchema` in
	// `types.ts`) so search-input refs / session refs / typed literals
	// can drive runtime match values. The type checker restricts the
	// shape to a `term`-arm ValueExpression — every wire target's
	// match emission consumes terms via the shared term-emission
	// infrastructure. Non-term ValueExpression arms (`arith`, `if`,
	// `count`, `format-date`, etc.) lack semantic meaning at a match
	// value position; reject them at construction so the wire-emission
	// layer never sees them.
	if (p.value.kind !== "term") {
		errors.push({
			path: [...path, "value"],
			message: `match value must be a term-arm ValueExpression (literal / property ref / search input / session ref); got '${p.value.kind}'.`,
		});
		return;
	}
	// Reject empty-string literals — every CCHQ match mode collapses
	// an empty value to a non-match per the schema JSDoc.
	if (p.value.term.kind === "literal" && p.value.term.value === "") {
		errors.push({
			path: [...path, "value"],
			message: `match value cannot be the empty string — every match mode collapses an empty value to a non-match (see matchSchema JSDoc). Use is-null(prop) for strict-absent or is-blank(prop) for absent-or-empty.`,
		});
	}
	// Type-check the value via the term resolver and verify its
	// resolved type is text-coercible for the chosen mode. text /
	// single_select / multi_select coerce naturally; `fuzzy-date`
	// additionally accepts date / datetime values (which the wire
	// layer renders as ISO strings). ANY_TYPE bypasses (null literal
	// compatibility).
	const valueType = resolveTermType(p.value.term, ctx, errors, [
		...path,
		"value",
		"term",
	]);
	if (
		valueType !== undefined &&
		valueType !== ANY_TYPE &&
		!allowList.has(valueType as CasePropertyDataType)
	) {
		const allowed = [...allowList].sort().join(", ");
		errors.push({
			path: [...path, "value"],
			message: `match mode='${p.mode}' requires a value resolving to ${allowed}; got '${describe(valueType)}'.`,
		});
	}
}

/**
 * Multi-select-only property requirement on
 * `multi-select-contains.property`, plus per-value type compatibility
 * across `values`. CCHQ's wire layer dispatches `selected-any` /
 * `selected-all` through `_selected_query` →
 * `case_property_query(..., multivalue_mode='or' | 'and')` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-51`,
 * and that path accepts text / single_select / multi_select uniformly.
 * The Nova rule is stricter: only a `multi_select` property has the
 * structural notion of "contains" (multi-token storage, per-token
 * containment), so routing single_select or text through this
 * operator is virtually always an authoring bug — the author meant
 * `match` (for substring / fuzzy semantics) or `eq` (for exact match).
 * Reject everything but `multi_select` so the typed AST steers
 * authors to the operator whose semantics actually fit.
 *
 * Per-value compatibility reuses the same `typesCompatible` table
 * comparisons and `in` use, so the widenings (null-as-universal,
 * select-to-text) carry over: a `null` literal in `values` is the
 * structural is-unset filter and compares-compatible against
 * `multi_select`. Each value's path threads its index so the editor
 * highlights the failing chip independently — same convention as `in`.
 */
function checkMultiSelectContains(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const propType = resolveTermType(p.property, ctx, errors, [
		...path,
		"property",
	]);
	// `ANY_TYPE` is structurally unreachable for a `PropertyRef` today
	// (only literal `null` resolves to the sentinel), but the explicit
	// guard pins the invariant at the type system: a future widening of
	// the multi-select-contains schema's operand or of
	// `resolveTermType`'s null handling fails the
	// `CasePropertyDataType`-typed equality check at compile time
	// instead of silently treating `_any` as "is multi_select." Same
	// rationale as the parallel guard in `checkMatch`.
	if (
		propType !== undefined &&
		propType !== ANY_TYPE &&
		propType !== "multi_select"
	) {
		errors.push({
			path: [...path, "property"],
			message: `multi-select-contains requires a multi_select-typed property; got '${describe(propType)}'.`,
		});
		// Property-rule rejection short-circuits the per-value
		// compatibility pass: every value would re-emit a downstream
		// "not comparable with <wrong-type>" error and bury the real
		// cause. The author needs to see the property-shape mismatch
		// first; per-value mismatches surface naturally once the
		// property type is fixed.
		return;
	}
	if (propType === undefined) return;
	for (let i = 0; i < p.values.length; i++) {
		const valType = literalType(p.values[i]);
		if (!typesCompatible(propType, valType)) {
			errors.push({
				path: [...path, "values", i],
				message: `Type mismatch: literal '${describe(valType)}' is not comparable with property type '${describe(propType)}'.`,
			});
		}
	}
}

/**
 * Operand-shape check shared by `is-null` (strict-absent) and
 * `is-blank` (absent-or-empty). Both operators ask "does `left`
 * resolve to absent (`is-null`) / absent-or-empty (`is-blank`)?",
 * which only has authoring semantics for terms whose value is read
 * at runtime — property refs, search-input refs, session-user refs,
 * session-context refs.
 *
 * Literal-shaped `left` is rejected as a category error: a literal
 * is the value itself (`literal("x")` IS the string `"x"`;
 * `literal(null)` IS null), not a runtime read whose presence is in
 * question. "Is the literal 5 absent?" is ill-formed, regardless of
 * whether the operator is the strict or the portable variant.
 * Pinning the rejection at the type-checker layer (rather than the
 * schema layer) keeps the schema structurally simple — every Term
 * variant is admitted at parse — and concentrates the semantic-class
 * rule in one place where the term discriminator is in scope.
 *
 * For non-literal terms, the helper resolves the term type for its
 * side effects (so unknown-property / unknown-input errors surface
 * uniformly with the comparison checker) but does not constrain it
 * — any data type can be absent at runtime, so there is no narrowing
 * to apply. The error path is `[...path, "left"]` so the editor
 * highlights the offending operand directly, matching the comparison
 * operators' per-side error attachment.
 *
 * The two operators are distinguished only at per-dialect wire
 * emission (`is-null` is unrepresentable on every CCHQ target;
 * `is-blank` emits `prop = ''` on every CCHQ dialect, with the
 * server-side `case_property_query()` short-circuit collapsing empty-
 * value queries to absent-or-empty semantics in CSQL); the type-
 * checker treats them identically because the operand-shape question
 * is the same. Spec subsection: "Null vs blank semantics" under the
 * Predicate family in
 * `docs/superpowers/specs/2026-04-30-case-list-search-design.md`.
 */
function checkAbsenceOperator(
	p: Extract<Predicate, { kind: "is-null" | "is-blank" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	// Literal-shaped operands are rejected as a category error. The
	// operand is `ValueExpression`, so a literal arrives inside the
	// `term` arm — pattern-match through the wrapper to keep the
	// rejection in place. Higher-order ValueExpression arms (`arith`,
	// `if`, `count`, etc.) are accepted: an arithmetic expression can
	// resolve to absent at runtime ("is the per-unit ratio
	// undefined?"), so the ill-formed framing only applies to pure-
	// literal operands. The arm walks the `value` even after pushing
	// the rejection error so any nested resolution failures inside
	// the literal-bearing wrapper still surface.
	if (p.left.kind === "term" && p.left.term.kind === "literal") {
		errors.push({
			path: [...path, "left"],
			message: `Operator '${p.kind}' cannot be applied to a literal — a literal is the value itself, not a runtime read whose presence is in question. Use a property / input / session reference in 'left'.`,
		});
		return;
	}
	checkExpression(p.left, ctx, errors, [...path, "left"]);
}

/**
 * Range-predicate rules for `between`. Three constraints, in order:
 *
 *   1. `left` resolves to one of the ordered types (`ORDERED_TYPES`).
 *      Strings, selects, geopoints, booleans cannot anchor a range
 *      because their wire targets either lack ordering semantics
 *      (text — see `ORDERED_TYPES`'s JSDoc) or aren't numerically /
 *      temporally meaningful (geopoint, select). Same allow-list the
 *      ordering arm of the comparison checker uses, locked to one
 *      constant so a future expansion (e.g. adding a duration type)
 *      reaches both surfaces in one edit.
 *
 *   2. Each provided bound (`lower` / `upper`) resolves to a type
 *      compatible with `left`'s resolved type via `typesCompatible`.
 *      The widenings comparison operators carry over — numeric
 *      promotion (`int` ↔ `decimal`), null-as-universal — so authors
 *      don't relearn compatibility per operator.
 *
 *   3. When both bounds are typed-literal Terms with statically
 *      comparable values and `lower > upper`, the predicate is
 *      identically false at every wire target. The schema admits the
 *      shape because bounds may also be Term refs (search-input,
 *      session-user, session-context) whose values aren't known until
 *      runtime — adding a literal-pair-only refinement at the schema
 *      layer would either miss the term-pair case (silent
 *      wrong-answer in the runtime path) or reject term-pair shapes
 *      the schema must accept. The type-checker is the right layer
 *      for the literal-pair check because it has the type context to
 *      recognise a typed-literal pair.
 *
 * Spec subsection: "Range predicate" under the Predicate family in
 * `docs/superpowers/specs/2026-04-30-case-list-search-design.md`. CCHQ
 * has no dedicated `between` function — it compiles to `>= AND <=` at
 * every wire target — so no per-dialect citation belongs here.
 */
function checkBetween(
	p: Extract<Predicate, { kind: "between" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = checkExpression(p.left, ctx, errors, [...path, "left"]);
	if (leftType === undefined) return;

	// Ordered-types check parallels the comparison checker's
	// `gt`/`gte`/`lt`/`lte` arm — `_any` (the null sentinel) bypasses
	// the check because `between(prop, null, null)` is meaningless but
	// `_any` itself never reaches `left` (the schema requires a value-
	// expression, not a literal-only slot).
	if (leftType !== ANY_TYPE && !ORDERED_TYPES.has(leftType)) {
		errors.push({
			path,
			message: `Operator 'between' requires an ordered left operand (int, decimal, date, datetime, time); got '${describe(leftType)}'. Strings are not ordered.`,
		});
		return;
	}

	// Per-bound resolution + compatibility. Bound errors attach to
	// the bound's own slot so the editor highlights the failing
	// operand directly. `_any` (null literal) widens via
	// `typesCompatible` — same null-as-universal carry-over the `in`
	// operator uses for its membership values.
	if (p.lower !== undefined) {
		const lowerType = checkExpression(p.lower, ctx, errors, [...path, "lower"]);
		if (lowerType !== undefined && !typesCompatible(leftType, lowerType)) {
			errors.push({
				path: [...path, "lower"],
				message: `Type mismatch: lower bound '${describe(lowerType)}' is not comparable with left operand type '${describe(leftType)}'.`,
			});
		}
	}
	if (p.upper !== undefined) {
		const upperType = checkExpression(p.upper, ctx, errors, [...path, "upper"]);
		if (upperType !== undefined && !typesCompatible(leftType, upperType)) {
			errors.push({
				path: [...path, "upper"],
				message: `Type mismatch: upper bound '${describe(upperType)}' is not comparable with left operand type '${describe(leftType)}'.`,
			});
		}
	}

	// Literal-pair impossibility check. After the operand widening,
	// the bounds arrive as `ValueExpression`; the literal pair only
	// reaches this branch when both bounds are the bare `term` lift
	// of a `literal` term. Higher-order ValueExpression bounds
	// (`arith` / `if` / `count` / search-input refs / etc.) reach
	// runtime values, and `>` against runtime-computed expressions is
	// undecidable here. The check uses JS-level `>` rather than a
	// type-aware comparator: typed-date literals carry ISO strings
	// whose lexicographic order matches chronological order
	// ("2024-01-01" < "2024-12-31"), and numeric literals compare
	// numerically by JS semantics. Booleans / strings without a
	// `data_type` qualifier reach this branch too; they fail the
	// ordered-types check above before getting here, so the literal-
	// pair detector only sees ordered-typed literal pairs.
	//
	// Caveat for typed `datetime` literals: TZ-suffixed ISO strings
	// can lex-disagree with UTC-instant ordering — e.g.,
	// "2024-01-01T00:00+05:00" lex-compares greater than
	// "2024-01-01T00:00+00:00" while the second names the later UTC
	// instant. CCHQ's wire convention is naive datetimes (no TZ
	// suffix) and the Nova `datetimeLiteral` builder produces the
	// same shape, so this check is correct in practice; if a future
	// surface admits TZ-suffixed datetimes the comparator needs to
	// parse + compare instants instead of strings.
	const lowerLit = unwrapLiteralOperand(p.lower);
	const upperLit = unwrapLiteralOperand(p.upper);
	if (
		lowerLit !== undefined &&
		upperLit !== undefined &&
		lowerLit.value !== null &&
		upperLit.value !== null &&
		lowerLit.value > upperLit.value
	) {
		errors.push({
			path,
			message: `Operator 'between' has lower bound '${String(lowerLit.value)}' greater than upper bound '${String(upperLit.value)}'; the interval is empty.`,
		});
	}
}

/**
 * Unwrap a ValueExpression that is structurally a lifted literal
 * Term and return the underlying `Literal`. Returns `undefined`
 * for any other shape (bare term that isn't a literal, an `arith`
 * expression, an `if`, etc.) so callers can dispatch on the
 * "literal-pair" pattern without re-walking the AST.
 *
 * Used by the `between` literal-pair impossibility check, which
 * only fires when both bounds are literal-shaped — runtime-computed
 * values can't be statically compared.
 */
function unwrapLiteralOperand(
	expr: ValueExpression | undefined,
): Literal | undefined {
	if (expr === undefined) return undefined;
	if (expr.kind !== "term") return undefined;
	if (expr.term.kind !== "literal") return undefined;
	return expr.term;
}

/**
 * Resolve a `RelationPath` to its destination case-type name. Returns
 * `undefined` on resolution failure (and pushes a `CheckError`),
 * mirroring `resolveTermType`'s short-circuit pattern so callers don't
 * have to handle resolution-failure cascades.
 *
 * The four kinds — three reachable from caller sites (`ancestor` /
 * `subcase` / `any-relation`), one structurally unreachable (`self`):
 *
 *   - `self` — `checkRelationalQuantifier` rejects standalone
 *     `via.kind === "self"` before invoking this helper, and
 *     `resolveTermType`'s `prop` arm short-circuits absent / `self`
 *     `via` to the originating-scope branch without touching this
 *     helper. The arm exists in the switch only for `RelationPath`
 *     discriminated-union exhaustiveness — adding a new kind without
 *     a parallel arm here is a TypeScript compile error rather than
 *     a silent fall-through. The runtime body throws to surface the
 *     invariant violation if any future caller routes `self` through
 *     this helper via an untyped boundary. The uniform top-level
 *     rejection of `exists(via: self)` is defensible because the
 *     shape (`exists(self, w)` reduces to `w(currentScope)`) is
 *     degenerate at every position; collapsing degenerate shapes is
 *     the reductions module's concern, not the type-checker's.
 *
 *   - `ancestor` — walk `parent_type` chain, one hop per `RelationStep`.
 *     The current `CaseType` schema models at most one parent, so each
 *     hop is `origin.parent_type` lookup. `throughCaseType` (when
 *     provided) validates `origin.parent_type === step.throughCaseType`
 *     at the hop. CCHQ source: `ancestor-exists` registered at
 *     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:51`,
 *     implementation at `ancestor_functions.py:97-118` (mandatory
 *     2-arg `confirm_args_count` at `:109` — the wire-layer optionality
 *     diverges from this schema's uniformly-optional `where`, but
 *     that's a representability concern, not a type-checker rule).
 *
 *   - `subcase` — find case types whose `parent_type` matches the
 *     origin. `ofCaseType` disambiguates when multiple candidates
 *     exist; with one candidate, the qualifier is optional. CCHQ
 *     source: `subcase-exists` registered at `__init__.py:41`,
 *     implementation at `subcase_functions.py:51-62` with the
 *     optional-filter check at `:207` — this matches the schema's
 *     uniformly-optional `where` shape.
 *
 *   - `any-relation` — direction-agnostic. The current `CaseType`
 *     schema models only one direction (a child names its
 *     `parent_type`), so the resolution semantics mirror `subcase`:
 *     find case types whose `parent_type` matches the origin. The
 *     directional-agnosticism is meaningful only when the underlying
 *     schema carries both directions, which is foundation work for a
 *     future `CaseType` extension. The kind exists in the AST today
 *     because the persisted-shape contract has to settle now (per the
 *     spec's "RelationPath" subsection); the representability checker
 *     rejects it for CCHQ wire targets where direction-specific
 *     operators are the only choice.
 *
 * **Principled narrowing — identifier→relationship matching:** the
 * current `CaseType` schema doesn't carry named relationships (no
 * `relationships` array; `parent_type` is a single nullable string,
 * `relationship` is a single nullable enum). The walk's `identifier`
 * field on each step is validated as XML-element-name vocabulary at
 * the schema layer (`relationStepSchema` in `types.ts`) but is not
 * matched against any case-type record here — the current schema has
 * no named-relationship surface to match against. Authors writing
 * `relationStep("parent")` and `relationStep("custom_index")` reach
 * the same destination via the same `parent_type` lookup; the
 * identifier rounds out the wire form (CCHQ emits the identifier
 * literally as the index name) but doesn't constrain destination
 * resolution at type-check time. Named relationships aren't
 * supported by the path resolver today; when the `CaseType` schema
 * grows them, this helper widens to consult the named-relationship
 * table.
 */
export function checkRelationPath(
	relationPath: RelationPath,
	originCaseType: string,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): string | undefined {
	switch (relationPath.kind) {
		case "self":
			// Upstream callers short-circuit `self` before recursing:
			// `checkRelationalQuantifier` rejects `via.kind === "self"`
			// at the operator boundary, and `resolveTermType`'s `prop`
			// arm routes self / absent vias through the originating-
			// scope branch. The arm is retained here for `RelationPath`
			// discriminated-union exhaustiveness; the uniform top-level
			// rejection of `exists(via: self)` is defensible because
			// the shape (`exists(self, w)` reduces to `w(currentScope)`)
			// is degenerate at every position, not only the top one —
			// collapsing degenerate shapes is the reductions module's
			// concern, not the type-checker's.
			throw new Error(
				[
					"`checkRelationPath` — `self` reached the relation-path checker, but every caller short-circuits `self` upstream.",
					"",
					"`self` walks have no destination distinct from the originating scope, so",
					"the relation-path-bearing arms (`exists(self)` / `missing(self)` /",
					"`count(self)` / `prop(via: self)`) are reduced or rejected at the",
					"operator-level checker before recursing into `checkRelationPath`. Reaching",
					"this throw means a new caller bypassed that short-circuit — either fix",
					"the caller, or document why `self` should now be a recursive case here.",
				].join("\n"),
			);

		case "ancestor": {
			// Walk the parent_type chain hop-by-hop. Each hop's origin
			// is the previous hop's destination; the first hop's origin
			// is the function's `originCaseType` argument. The i==0
			// lookup can fail when the caller passed an originating case
			// type the schema doesn't declare (e.g., a `prop` term with
			// a typo'd `caseType`); subsequent hops fail when the
			// previously-resolved destination type is missing from the
			// schema, which Plan 3's blueprint validator should prevent
			// but the type checker still guards.
			let current = originCaseType;
			for (let i = 0; i < relationPath.via.length; i++) {
				const step = relationPath.via[i];
				const ct = ctx.caseTypes.find((c) => c.name === current);
				if (!ct) {
					errors.push({
						path,
						message:
							i === 0
								? `Unknown originating case type '${current}' on relation walk.`
								: `Unknown case type '${current}' at ancestor hop ${i}.`,
					});
					return undefined;
				}
				if (!ct.parent_type) {
					errors.push({
						path,
						message: `Ancestor walk failed: case type '${current}' has no parent_type.`,
					});
					return undefined;
				}
				if (
					step.throughCaseType !== undefined &&
					step.throughCaseType !== ct.parent_type
				) {
					errors.push({
						path,
						message: `throughCaseType '${step.throughCaseType}' on ancestor step does not match the actual parent_type '${ct.parent_type}' of '${current}'.`,
					});
					return undefined;
				}
				current = ct.parent_type;
			}
			// Confirm the final destination exists in the case-type
			// table. Catches the dangling-parent case where a case type
			// names a `parent_type` that doesn't exist as a sibling
			// `CaseType` record.
			if (!ctx.caseTypes.some((c) => c.name === current)) {
				errors.push({
					path,
					message: `Ancestor walk's destination case type '${current}' is not declared.`,
				});
				return undefined;
			}
			return current;
		}

		case "subcase":
		case "any-relation": {
			// Find case types whose `parent_type` matches the origin.
			// `subcase` and `any-relation` share resolution semantics
			// because the current `CaseType` schema models only one
			// direction (see the helper's JSDoc); they diverge at the
			// wire layer (per-dialect representability), not at
			// type-check time.
			const candidates = ctx.caseTypes.filter(
				(c) => c.parent_type === originCaseType,
			);
			if (relationPath.ofCaseType !== undefined) {
				// `ofCaseType` validates against `caseTypes` directly:
				// it must name a declared case type (otherwise the
				// destination scope is unknowable) and that case type
				// must in fact be a subcase of the origin. The two
				// arms produce distinct messages so the editor can
				// route the user-facing fix correctly.
				const named = ctx.caseTypes.find(
					(c) => c.name === relationPath.ofCaseType,
				);
				if (!named) {
					errors.push({
						path,
						message: `Unknown case type '${relationPath.ofCaseType}' on '${relationPath.kind}' walk.`,
					});
					return undefined;
				}
				if (named.parent_type !== originCaseType) {
					errors.push({
						path,
						message: `Case type '${relationPath.ofCaseType}' is not a subcase of '${originCaseType}' (its parent_type is '${named.parent_type ?? "<none>"}').`,
					});
					return undefined;
				}
				return relationPath.ofCaseType;
			}
			// No qualifier — accept the unique candidate, reject the
			// ambiguous case. The zero-candidate case is its own
			// failure mode (no case type names the origin as a
			// parent), distinct from the ambiguous case.
			if (candidates.length === 0) {
				errors.push({
					path,
					message: `'${relationPath.kind}' walk failed: no case type declares '${originCaseType}' as its parent_type.`,
				});
				return undefined;
			}
			if (candidates.length > 1) {
				errors.push({
					path,
					message: `'${relationPath.kind}' walk is ambiguous: multiple case types (${candidates.map((c) => `'${c.name}'`).join(", ")}) declare '${originCaseType}' as their parent_type. Add 'ofCaseType' to disambiguate.`,
				});
				return undefined;
			}
			return candidates[0].name;
		}

		default: {
			// Exhaustiveness assertion — adding a `RelationPath` kind
			// without a parallel arm here is a compile-time error.
			const _exhaustive: never = relationPath;
			throw new Error(
				unhandledKindMessage({
					where: "checkRelationPath",
					family: "RelationPath",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["self", "ancestor", "subcase", "any-relation"],
				}),
			);
		}
	}
}

/**
 * Recursively type-check a predicate in a destination scope rebound
 * via `currentCaseType`. Used by `checkRelationalQuantifier` to walk
 * `exists.where` / `missing.where` against the destination of the
 * outer `via` rather than the originating scope.
 *
 * The scope rebinding is the load-bearing primitive: nested `exists`
 * / `missing` inside the where-clause read the new
 * `currentCaseType` from the rebound context, so chained relational
 * walks resolve correctly without further plumbing. The
 * `prop.caseType === currentCaseType` constraint inside
 * `resolveTermType` fires whenever `currentCaseType` is set —
 * enforcing the destination-scope contract uniformly across
 * top-level and nested arms.
 *
 * Spec contract: the where-clause's `prop` references must name the
 * destination case type as their originating scope (the spec's
 * "originating-scope rule" locked by the JSDoc on
 * `propertyRefSchema.caseType`). The constraint is encoded inside
 * `resolveTermType` rather than walked here because it's a per-term
 * rule, not a structural recursion shape.
 */
export function checkInDestinationScope(
	predicate: Predicate,
	destinationCaseType: string,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const scopedCtx: TypeContext = {
		...ctx,
		currentCaseType: destinationCaseType,
	};
	walk(predicate, scopedCtx, errors, path);
}

/**
 * Type-check `exists` / `missing`. The two kinds share one rule shape:
 *
 *   1. `via` resolves to a destination case type via
 *      `checkRelationPath`. Top-level `via.kind === "self"` is
 *      rejected as meaningless (a self-relation says "does this case
 *      have itself," which is always true). Nested `self` inside a
 *      where-clause routes through to the enclosing scope and is
 *      handled inside `checkRelationPath`.
 *
 *   2. The originating scope must be set on the context. At the top
 *      level Plan 3 supplies it from the case-list / search config;
 *      inside a where-clause `checkInDestinationScope` rebinds it to
 *      the parent's destination. Without an origin, the walk has no
 *      anchor — emit a precise error rather than silently bypassing
 *      the rule.
 *
 *   3. `where` (if present) is type-checked recursively in the
 *      destination scope via `checkInDestinationScope`. The path
 *      threads the kind segment so a where-clause violation surfaces
 *      with `[..., "exists" | "missing", "where", ...]`.
 *
 * Spec subsection: "Relation paths" and the `exists` / `missing` arms
 * of the Predicate family in
 * `docs/superpowers/specs/2026-04-30-case-list-search-design.md`. CCHQ
 * source citations live on `checkRelationPath`'s JSDoc and on the
 * relation-path schemas in `types.ts`.
 */
function checkRelationalQuantifier(
	p: Extract<Predicate, { kind: "exists" | "missing" }>,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	if (ctx.currentCaseType === undefined) {
		errors.push({
			path,
			message: `'${p.kind}' requires an originating case type to anchor the relation walk; supply 'currentCaseType' on the type-checker context.`,
		});
		return;
	}
	if (p.via.kind === "self") {
		// At the top level, `via: self` is a self-relation — "does
		// this case have itself" — which is always true and almost
		// certainly an authoring bug. Inside a where-clause `self`
		// has well-defined semantics (no further traversal), but the
		// relational-quantifier wrapper itself never makes sense at
		// the outer position with `self`. Reject loudly.
		errors.push({
			path,
			message: `'${p.kind}' with 'via: self' is meaningless: every case has itself, so the predicate is identically true. Use 'self' inside a 'where' clause to express "no further traversal."`,
		});
		return;
	}
	const destination = checkRelationPath(
		p.via,
		ctx.currentCaseType,
		ctx,
		errors,
		path,
	);
	if (destination === undefined) return;
	if (p.where !== undefined) {
		checkInDestinationScope(p.where, destination, ctx, errors, [
			...path,
			p.kind,
			"where",
		]);
	}
}

// ---------- Term resolution ----------

/**
 * Resolve a term to its data type, pushing a `CheckError` and returning
 * `undefined` if resolution fails. Returning `undefined` instead of a
 * placeholder type lets callers short-circuit the downstream
 * compatibility check (see `checkComparison`'s early-return) so the
 * author sees only the real cause, not a cascading mismatch.
 *
 * `data_type ?? "text"` mirrors `propertyToSchema` in `jsonSchema.ts`:
 * when the blueprint omits a data type, the property is treated as
 * text — CommCare's default for unannotated properties.
 */
export function resolveTermType(
	term: Term,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): ResolvedType | undefined {
	switch (term.kind) {
		case "prop": {
			// `caseType` names the originating scope (the predicate's
			// "self" position), per the contract on
			// `propertyRefSchema.caseType`. With `via` absent or
			// `{ kind: "self" }`, the property is read directly on
			// `caseType`. With a non-self `via`, the walk resolves to a
			// destination case type and the property is read on the
			// destination — `caseType` stays the originating scope and
			// the destination is recovered via `checkRelationPath`.
			//
			// Destination-scope pin: when `ctx.currentCaseType` is set
			// (top-level by Plan 3, inside a where-clause by
			// `checkInDestinationScope`'s rebinding), the term's
			// originating-scope qualifier MUST equal it. The pin enforces
			// the spec contract that a where-clause's `prop` references
			// name the destination of the surrounding `via`. The check
			// gates on `currentCaseType !== undefined` so call sites that
			// don't exercise relational features (existing comparison /
			// membership / absence tests) compose the context without a
			// `currentCaseType` field and the constraint stays inert.
			if (
				ctx.currentCaseType !== undefined &&
				term.caseType !== ctx.currentCaseType
			) {
				errors.push({
					path,
					message: `Property reference originating scope '${term.caseType}' must equal the current scope '${ctx.currentCaseType}'.`,
				});
				return undefined;
			}
			// Determine the case type the property is actually read on.
			// `self` and absent `via` route through the originating
			// scope; non-self `via` routes through `checkRelationPath`'s
			// destination resolution.
			let lookupCaseType: string;
			if (term.via === undefined || term.via.kind === "self") {
				lookupCaseType = term.caseType;
			} else {
				const destination = checkRelationPath(
					term.via,
					term.caseType,
					ctx,
					errors,
					path,
				);
				if (destination === undefined) return undefined;
				lookupCaseType = destination;
			}
			const ct = ctx.caseTypes.find((c) => c.name === lookupCaseType);
			if (!ct) {
				errors.push({
					path,
					message: `Unknown case type '${lookupCaseType}'.`,
				});
				return undefined;
			}
			const property = ct.properties.find((p) => p.name === term.property);
			if (!property) {
				errors.push({
					path,
					message: `Unknown property '${term.property}' on case type '${lookupCaseType}'.`,
				});
				return undefined;
			}
			return property.data_type ?? "text";
		}
		case "input": {
			const decl = ctx.knownInputs.find((i) => i.name === term.name);
			if (!decl) {
				errors.push({
					path,
					message: `Unknown search input '${term.name}'.`,
				});
				return undefined;
			}
			return decl.data_type ?? "text";
		}
		case "session-user":
			// Open-namespace custom user-data fields resolve to text. The
			// wire path `instance('commcaresession')/session/user/data/<field>`
			// is populated by `addUserProperties` at
			// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`,
			// which writes the user's `userFields` Hashtable as `<data>`
			// children under `<user>`. Hashtable values are strings at the
			// wire — every custom user-data field comes back as a string
			// regardless of whether the project semantically tracks it as
			// a number or a date. The type checker therefore returns
			// `text` unconditionally; authors who need a typed read coerce
			// upstream of the predicate at the form-write boundary or via
			// a calculated column.
			return "text";
		case "session-context":
			// Closed-namespace framework-controlled context fields also
			// resolve to text for v1's four-field set. The wire path
			// `instance('commcaresession')/session/context/<field>` is
			// populated by `addMetadata` at
			// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`,
			// which writes each of the four authoring-exposed fields
			// (`SESSION_CONTEXT_FIELDS` in `types.ts`) as a wire string.
			// `userid` / `username` / `deviceid` are identifiers; lex
			// comparison is the natural order for identifier equality
			// and prefix queries. `appversion` is also a wire string —
			// CCHQ exposes no semver-aware comparator against
			// `/session/context/appversion`, and lex ordering is the
			// only ordering authors get there (with the caveat that
			// e.g. `'10.0' < '2.0'` and `'2.53.0' < '2.9.0'` — once
			// digit counts diverge, lex compare disagrees with semver
			// intuition). Returning `"text"` reflects what the wire
			// carries; whether an author's `appversion`-comparison
			// expresses correct semantic gating is a Plan 3 / validator
			// concern, not a type-checker concern.
			//
			// If `drift` (a numeric clock-skew metric) ever joins the
			// enum, this arm becomes mode-aware: dispatch on
			// `term.field` to return `int` for `drift` and `text` for
			// the rest. The closed enum gives that future change a
			// structural anchor — the dispatch is one switch, not a
			// per-call lookup.
			return "text";
		case "literal":
			return literalType(term);
		default: {
			// Exhaustiveness assertion — a future widening of `Term`
			// (e.g. adding a `kind: "function"` arm for computed
			// expressions) without a parallel arm here would otherwise
			// silently fall through to `undefined`, looking the same as
			// a legitimate resolution failure to every caller. The
			// `never` assertion catches the omission at compile time;
			// the runtime throw guards untyped boundaries that bypass
			// the type system.
			const _exhaustive: never = term;
			throw new Error(
				unhandledKindMessage({
					where: "resolveTermType",
					family: "Term",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"prop",
						"literal",
						"input",
						"session-user",
						"session-context",
					],
				}),
			);
		}
	}
}

// ---------- ValueExpression resolution ----------
//
// `checkExpression(expr, ctx, errors, path)` is the value-side analogue
// of `resolveTermType`: it walks a `ValueExpression` against a
// `TypeContext`, resolves the expression's output type, and pushes any
// per-arm or recursive errors onto the `errors` array.
//
// Per-arm rules (per the design spec
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "Expression family"):
//
//   - `term` — delegates to `resolveTermType` for the lifted Term.
//   - `today` → `date`; `now` → `datetime` (wire-form constants).
//   - `date-add` → same type as the `date` operand; `quantity` must
//     resolve to a numeric type (int or decimal under the same
//     promotion rule comparison operators use).
//   - `date-coerce` → `date`; `datetime-coerce` → `datetime`. Each
//     accepts a text-shaped operand (text / single_select /
//     multi_select); the wire layer parses the string at evaluation.
//   - `double` → `decimal`. Accepts any term whose type is text or
//     numeric (the wire `double(...)` is a forced numeric coercion).
//   - `arith` → numeric. Both operands must be numeric; result is
//     `int` if both are `int`, otherwise `decimal` (the int×int=int /
//     mixed=decimal promotion rule that mirrors Postgres + CCHQ wire
//     semantics).
//   - `concat` → `text`. Each part casts to text at evaluation, so no
//     per-part type rule beyond resolution.
//   - `coalesce` → the agreed type across `values`. Empty-string and
//     null inputs coerce to null at evaluation, so the type checker
//     uses `typesCompatible` to find the agreed type — first non-null
//     non-sequence value's type wins, with subsequent values widened
//     against it.
//   - `if` → cond is type-checked recursively as a Predicate (must be
//     well-typed; the rule's verdict is not a typed value because
//     `cond` evaluates to boolean by construction). Both branches
//     must agree on type via `typesCompatible`. Result is the
//     branches' agreed type; if branches disagree, the verdict is
//     `_any` (ANY_TYPE) and an error is pushed.
//   - `switch` → similar to `if`. Each `case.when` literal must be
//     compatible with `on`'s resolved type; each `case.then` and the
//     `fallback` must agree on type. Result is the agreed type.
//   - `count` → `int`. The relation walk is type-checked via
//     `checkRelationPath`; the optional `where` clause is type-
//     checked recursively in the destination scope via
//     `checkInDestinationScope`.
//   - `unwrap-list` → `_sequence` (the `SEQUENCE_TYPE` sentinel). The
//     operand must be text-typed (the wire layer expects a JSON-
//     encoded array string).
//   - `format-date` → `text`. The `date` operand must resolve to
//     `date` or `datetime`.
//
// Cross-family recursion: `if.cond` and `count.where` carry
// Predicates, recursed via `walk(p, ctx, errors, path)` (the private
// dispatcher). `switch.cases[].when` carries a `Literal` (not a
// Predicate), so the recursion stops at the literal-type lookup.
//
// Error propagation: like `resolveTermType`, a resolution failure
// returns `undefined` and pushes an error onto the path. Callers
// short-circuit downstream compatibility checks on `undefined` to
// avoid cascading mismatches. Per-operator semantic rules (e.g.
// "arith requires numeric operands") attach to the operator's own
// path, not to the operand's slot path; operand resolution errors
// already carry their own per-side paths.

/**
 * Walk a `ValueExpression` against the supplied context and return
 * its resolved type, pushing any per-arm errors onto `errors`.
 * Returns `undefined` on resolution failure so callers can short-
 * circuit downstream compatibility checks the same way
 * `resolveTermType` does.
 *
 * Mutual recursion with `walk` (the Predicate dispatcher): `if.cond`
 * / `count.where` route through `walk` so a Predicate violation
 * inside an Expression surfaces with a path that threads through
 * both ASTs. Mutual recursion with itself for value-bearing slots
 * (`arith.left`, `if.then`, etc.).
 */
export function checkExpression(
	expr: ValueExpression,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): ResolvedType | undefined {
	switch (expr.kind) {
		case "term":
			// Delegate to the term-resolution path so unknown-property,
			// unknown-input, and originating-scope-pin errors surface
			// with the same shape they do for bare-term operands. The
			// path threads through unchanged because the `term` arm is a
			// structural lifter — the underlying Term is the
			// authoring-time identity from the caller's perspective.
			return resolveTermType(expr.term, ctx, errors, path);

		case "today":
			return "date";

		case "now":
			return "datetime";

		case "date-add": {
			// Resolve both operands first so per-side errors surface
			// uniformly. The operator-level rule applies after operand
			// resolution: `date` must be `date` or `datetime`;
			// `quantity` must be numeric.
			const dateType = checkExpression(expr.date, ctx, errors, [
				...path,
				"date",
			]);
			const quantityType = checkExpression(expr.quantity, ctx, errors, [
				...path,
				"quantity",
			]);
			if (dateType !== undefined && !isDateOrDatetime(dateType)) {
				errors.push({
					path: [...path, "date"],
					message: `date-add requires a date or datetime; got '${describe(dateType)}'.`,
				});
			}
			if (quantityType !== undefined && !isNumeric(quantityType)) {
				errors.push({
					path: [...path, "quantity"],
					message: `date-add requires a numeric quantity (int or decimal); got '${describe(quantityType)}'.`,
				});
			}
			// Result type follows the `date` operand's type — `date`
			// stays `date`, `datetime` stays `datetime`. On resolution
			// failure return undefined; on type-rule failure return
			// `date` defensively (the canonical no-op default for
			// downstream compatibility checks). The interval enum
			// (`DATE_ADD_INTERVALS`) is schema-validated, so the
			// runtime payload is always one of the seven; no per-
			// interval rule applies at this layer.
			void (expr.interval satisfies DateAddInterval);
			if (dateType === undefined) return undefined;
			return dateType;
		}

		case "date-coerce":
		case "datetime-coerce": {
			// Both coercion operators accept a text-shaped operand and
			// produce the corresponding date / datetime type. The
			// allow-list mirrors `MATCH_PROPERTY_TYPES_TEXT_SHAPED` —
			// `text` / `single_select` / `multi_select` all wire-store
			// as text, so each is admissible source for the coercion.
			// `_any` (the null sentinel) bypasses the check —
			// `date-coerce(literal(null))` is well-typed at the AST and
			// degenerates at runtime.
			const inner = checkExpression(expr.value, ctx, errors, [
				...path,
				"value",
			]);
			if (
				inner !== undefined &&
				inner !== ANY_TYPE &&
				!TEXT_SHAPED_TYPES.has(inner)
			) {
				errors.push({
					path: [...path, "value"],
					message: `${expr.kind} requires a text-shaped operand (text / single_select / multi_select); got '${describe(inner)}'.`,
				});
			}
			return expr.kind === "date-coerce" ? "date" : "datetime";
		}

		case "double": {
			// CSQL's `double(...)` is a forced numeric coercion. The
			// operand must be text or numeric — booleans coerce to
			// text upstream so they pass the text gate. `_any` bypasses
			// uniformly. Coordinates / dates / datetimes / times are
			// rejected because their wire-form numeric coercion is
			// undefined.
			const inner = checkExpression(expr.value, ctx, errors, [
				...path,
				"value",
			]);
			if (
				inner !== undefined &&
				inner !== ANY_TYPE &&
				!TEXT_SHAPED_TYPES.has(inner) &&
				!isNumeric(inner)
			) {
				errors.push({
					path: [...path, "value"],
					message: `double requires a text-shaped or numeric operand; got '${describe(inner)}'.`,
				});
			}
			return "decimal";
		}

		case "arith": {
			// Both operands must resolve to numeric types. Result type:
			// `int` if both operands are `int`; otherwise `decimal`.
			// Same int×int=int / mixed=decimal promotion rule that
			// mirrors Postgres' numeric coercion and CCHQ's wire-layer
			// behavior. `_any` (null literal) bypasses the numeric
			// check — `arith(prop, literal(null), "+")` is well-typed
			// at the AST and degenerates at runtime.
			const leftType = checkExpression(expr.left, ctx, errors, [
				...path,
				"left",
			]);
			const rightType = checkExpression(expr.right, ctx, errors, [
				...path,
				"right",
			]);
			if (
				leftType !== undefined &&
				leftType !== ANY_TYPE &&
				!isNumeric(leftType)
			) {
				errors.push({
					path: [...path, "left"],
					message: `arith requires numeric operands; left got '${describe(leftType)}'.`,
				});
			}
			if (
				rightType !== undefined &&
				rightType !== ANY_TYPE &&
				!isNumeric(rightType)
			) {
				errors.push({
					path: [...path, "right"],
					message: `arith requires numeric operands; right got '${describe(rightType)}'.`,
				});
			}
			void (expr.op satisfies ArithOp);
			if (leftType === undefined || rightType === undefined) {
				return undefined;
			}
			// int×int=int — both operands resolved as `int` produces
			// `int`. Any non-int (including `_any`) widens to decimal,
			// matching the comparison-side numeric-promotion rule.
			return leftType === "int" && rightType === "int" ? "int" : "decimal";
		}

		case "concat": {
			// Each part casts to text at evaluation — no per-part type
			// rule beyond resolution. Walk every part so per-part
			// errors surface; the operator's resolved type is `text`
			// regardless. `parts` is non-empty by schema; the loop
			// covers every part.
			for (let i = 0; i < expr.parts.length; i++) {
				checkExpression(expr.parts[i], ctx, errors, [...path, "parts", i]);
			}
			return "text";
		}

		case "coalesce": {
			// `values` must agree on type (after empty-string-coerce-
			// to-null). Walk each value, accumulate the agreed type via
			// `accumulateBranchType` — the first concrete (non-`_any`)
			// value becomes the seed; subsequent values must be
			// compatible with it. `_any` (null literal) widens freely.
			// If the seed and a later value disagree, the helper pushes
			// a mismatch error onto the disagreeing slot's path.
			let agreed: ResolvedType | undefined;
			for (let i = 0; i < expr.values.length; i++) {
				const t = checkExpression(expr.values[i], ctx, errors, [
					...path,
					"values",
					i,
				]);
				agreed = accumulateBranchType(
					agreed,
					t,
					errors,
					[...path, "values", i],
					"coalesce values must agree on type",
				);
			}
			// Default to `_any` if every value resolved to null — the
			// expression is structurally `coalesce(null, null, ...)`,
			// equivalent to `null` at runtime.
			return agreed ?? ANY_TYPE;
		}

		case "if": {
			// Recursively type-check `cond` as a Predicate. The
			// dispatcher (`walk`) accumulates errors with path-
			// threading so a violation deep inside the condition
			// surfaces precisely. Then resolve both branches via
			// `accumulateBranchType` — the same helper coalesce /
			// switch use, called twice with the same operator-scoped
			// path so a then/else type mismatch surfaces with the
			// uniform "not comparable with the established" message.
			walk(expr.cond, ctx, errors, [...path, "if", "cond"]);
			const thenType = checkExpression(expr.then, ctx, errors, [
				...path,
				"if",
				"then",
			]);
			const elseType = checkExpression(expr.else, ctx, errors, [
				...path,
				"if",
				"else",
			]);
			let agreed = accumulateBranchType(
				undefined,
				thenType,
				errors,
				[...path, "if"],
				"if branches must agree on type",
			);
			agreed = accumulateBranchType(
				agreed,
				elseType,
				errors,
				[...path, "if"],
				"if branches must agree on type",
			);
			return agreed;
		}

		case "switch": {
			// Resolve `on` first so the per-case `when` literals can be
			// compared against it. Each `case.when` is a `Literal` (not
			// a Predicate), so the literal-type lookup runs directly.
			// Per-case `then` types and the trailing `fallback` type
			// thread through `accumulateBranchType` for the agreement
			// check — same helper coalesce uses.
			const onType = checkExpression(expr.on, ctx, errors, [
				...path,
				"switch",
				"on",
			]);
			let agreed: ResolvedType | undefined;
			for (let i = 0; i < expr.cases.length; i++) {
				const c = expr.cases[i];
				const whenType = literalType(c.when);
				if (onType !== undefined && !typesCompatible(onType, whenType)) {
					errors.push({
						path: [...path, "switch", "cases", i, "when"],
						message: `switch case 'when' literal '${describe(whenType)}' is not comparable with switch.on type '${describe(onType)}'.`,
					});
				}
				const thenType = checkExpression(c.then, ctx, errors, [
					...path,
					"switch",
					"cases",
					i,
					"then",
				]);
				agreed = accumulateBranchType(
					agreed,
					thenType,
					errors,
					[...path, "switch", "cases", i, "then"],
					"switch case 'then' type must agree with the established branch type",
				);
			}
			const fallbackType = checkExpression(expr.fallback, ctx, errors, [
				...path,
				"switch",
				"fallback",
			]);
			agreed = accumulateBranchType(
				agreed,
				fallbackType,
				errors,
				[...path, "switch", "fallback"],
				"switch fallback type must agree with the established branch type",
			);
			return agreed ?? ANY_TYPE;
		}

		case "count": {
			// Relational aggregation: walk `via` to a destination scope,
			// then type-check the optional `where` clause in that
			// scope. The `count` arm always returns `int` — the wire
			// targets all return integer cardinality.
			//
			// Top-level `via.kind === "self"` is meaningless ("count
			// the current case as itself" is always 1). The
			// representability checker / authoring UI rejects this
			// pattern at authoring time; the type checker omits the
			// rule for parity with `exists(self)` / `missing(self)`,
			// both rejected in `checkRelationalQuantifier` rather
			// than here.
			const origin = ctx.currentCaseType;
			if (origin === undefined) {
				errors.push({
					path: [...path, "count"],
					message:
						"count requires a current case-type scope; the originating scope must be set on the type-check context.",
				});
				return "int";
			}
			if (expr.via.kind !== "self") {
				const destination = checkRelationPath(expr.via, origin, ctx, errors, [
					...path,
					"count",
					"via",
				]);
				if (destination !== undefined && expr.where !== undefined) {
					checkInDestinationScope(expr.where, destination, ctx, errors, [
						...path,
						"count",
						"where",
					]);
				}
			} else if (expr.where !== undefined) {
				// `via.kind === "self"` — the scope rebinding is a no-op,
				// but the where-clause is still walked in the current
				// scope so its rule violations surface.
				walk(expr.where, ctx, errors, [...path, "count", "where"]);
			}
			return "int";
		}

		case "unwrap-list": {
			// Operand must be text-shaped — the wire form expects a
			// JSON-encoded array string. Result is the sequence
			// sentinel; v1 has no AST consumer for it (see
			// `SEQUENCE_TYPE`'s JSDoc) but the type checker stages the
			// verdict for the wire emitter to consume.
			const inner = checkExpression(expr.value, ctx, errors, [
				...path,
				"value",
			]);
			if (
				inner !== undefined &&
				inner !== ANY_TYPE &&
				!TEXT_SHAPED_TYPES.has(inner)
			) {
				errors.push({
					path: [...path, "value"],
					message: `unwrap-list requires a text-shaped operand; got '${describe(inner)}'.`,
				});
			}
			return SEQUENCE_TYPE;
		}

		case "format-date": {
			// Operand must be date or datetime. Result is text. The
			// `pattern` slot is schema-validated (preset enum or non-
			// empty string), so no per-pattern rule applies here.
			const inner = checkExpression(expr.date, ctx, errors, [...path, "date"]);
			if (inner !== undefined && !isDateOrDatetime(inner)) {
				errors.push({
					path: [...path, "date"],
					message: `format-date requires a date or datetime; got '${describe(inner)}'.`,
				});
			}
			return "text";
		}

		default: {
			// Exhaustiveness assertion — adding a kind to
			// `ValueExpression` without a parallel arm here is a TS
			// compile-time error. The runtime throw guards untyped
			// boundaries that bypass the type system.
			const _exhaustive: never = expr;
			throw new Error(
				unhandledKindMessage({
					where: "checkExpression",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
					],
				}),
			);
		}
	}
}

// ---------- ValueExpression rule helpers ----------

/**
 * Numeric (`int` or `decimal`) — the operand-type set for `arith`'s
 * operands and `date-add.quantity`. Sharing the helper keeps the
 * numeric-shape predicate consistent across every arm that uses it
 * and surfaces a future widening (e.g. a separate `bigint` type) as
 * a single edit site.
 */
function isNumeric(t: ResolvedType): boolean {
	return t === "int" || t === "decimal";
}

/**
 * Date or datetime — the operand-type set for `date-add.date` and
 * `format-date.date`. `time` is intentionally excluded; CCHQ's wire
 * `date-add` doesn't recognise time-only operands and `format-date`
 * has no rendering pattern that fits a bare time.
 */
function isDateOrDatetime(t: ResolvedType): boolean {
	return t === "date" || t === "datetime";
}

/**
 * Text-shaped types — the operand-type set for `date-coerce` /
 * `datetime-coerce` / `unwrap-list` / `double` (text branch). Same
 * set the match-mode allow-list uses; sharing keeps the "what
 * counts as a text-shaped read" decision in one place.
 */
const TEXT_SHAPED_TYPES: ReadonlySet<ResolvedType> = new Set<ResolvedType>([
	"text",
	"single_select",
	"multi_select",
]);

/**
 * Accumulate one branch's resolved type into the running `agreed` type
 * across a multi-branch operator (`coalesce` values, `switch.cases[].then`
 * + `switch.fallback`, `if`'s then/else pair). The first concrete (non-
 * `_any`) candidate becomes the seed; later candidates must be
 * compatible with it via `typesCompatible`. `_any` (the null-literal
 * sentinel) widens freely. Resolution failures (`candidate === undefined`)
 * are no-ops at this layer because the per-slot resolution call already
 * pushed its own error.
 *
 * Behaviour matrix:
 *   - `candidate === undefined` → return `agreed` unchanged. The slot's
 *     own resolution error is in `errors` already.
 *   - `candidate === ANY_TYPE` → return `agreed ?? ANY_TYPE`. Null
 *     widens to anything; if no agreed type yet, the slot resolves the
 *     accumulator to ANY_TYPE so the next concrete candidate can take
 *     over as seed.
 *   - `agreed === undefined || agreed === ANY_TYPE` → return
 *     `candidate`. First concrete candidate seeds the accumulator.
 *   - `typesCompatible(agreed, candidate)` → return `agreed`. Compatible
 *     types widen the same way at every consumer; one of them serves as
 *     the agreed result.
 *   - Otherwise → push a mismatch error on `errorPath` and return
 *     `agreed` (don't let a later disagreement re-seed the accumulator
 *     to a fresh type, which would mask the established branch type
 *     and cascade further mismatches).
 *
 * Used by every multi-branch arm in `checkExpression` so the helper
 * is the single place to update if the agreement-rule policy
 * changes. The error message takes a per-call `errorPrefix` so the
 * operator-context is named at the callsite (e.g. "coalesce values
 * must agree on type") and the helper appends the standard
 * "<candidate>' is not comparable with the established '<agreed>'"
 * suffix. The `errorPath` lets per-element callsites attach the
 * error to the disagreeing element's slot (e.g. the i-th
 * `switch.cases[].then`); operator-level callers pass a path scoped
 * to the operator itself.
 */
function accumulateBranchType(
	agreed: ResolvedType | undefined,
	candidate: ResolvedType | undefined,
	errors: CheckError[],
	errorPath: CheckPath,
	errorPrefix: string,
): ResolvedType | undefined {
	if (candidate === undefined) return agreed;
	if (candidate === ANY_TYPE) return agreed ?? ANY_TYPE;
	if (agreed === undefined || agreed === ANY_TYPE) return candidate;
	if (typesCompatible(agreed, candidate)) return agreed;
	errors.push({
		path: errorPath,
		message: `${errorPrefix}; '${describe(candidate)}' is not comparable with the established '${describe(agreed)}'.`,
	});
	return agreed;
}

/**
 * Map a literal to its data type. Three resolution sources, in order:
 *   1. `lit.data_type` — explicit, set by the typed builders
 *      (`dateLiteral` / `datetimeLiteral` / `timeLiteral`). Wins
 *      unconditionally because the author has already declared the
 *      semantic type.
 *   2. `null` value — resolves to the internal `_any` sentinel so it
 *      compares against any declared property type. See `ANY_TYPE`'s
 *      JSDoc for the rationale.
 *   3. JS runtime type — for untyped literals, infer from the JS
 *      value: strings become `text`, numbers split int / decimal via
 *      `Number.isInteger` (so the numeric-promotion rule in
 *      `typesCompatible` handles `int` / `decimal` interchangeably),
 *      booleans become `text` (CommCare has no Boolean data type, so
 *      booleans coerce to one of the available buckets and `text` is
 *      the only viable target — wire encoding decisions, e.g.
 *      `"True"` vs `"true"` vs `"1"`, live at the wire-emit boundary,
 *      not here).
 */
export function literalType(lit: Literal): ResolvedType {
	if (lit.data_type) return lit.data_type;
	if (lit.value === null) return ANY_TYPE;
	switch (typeof lit.value) {
		case "string":
			return "text";
		case "number":
			return Number.isInteger(lit.value) ? "int" : "decimal";
		case "boolean":
			return "text";
		default: {
			// Unreachable at runtime — `literalSchema.value` is
			// `string | number | boolean | null` and null is handled
			// above. The `never` assertion catches a future schema
			// widening (e.g. accepting bigint / date) that misses a
			// parallel arm here.
			const _exhaustive: never = lit.value;
			throw new Error(
				unhandledKindMessage({
					where: "literalType",
					family: "literal value type (`typeof`)",
					received: typeof _exhaustive,
					knownKinds: ["string", "number", "boolean", "null"],
				}),
			);
		}
	}
}

// ---------- Compatibility table ----------

/**
 * Decide whether two resolved types may participate in a comparison.
 * Five classes of widening are in play:
 *   1. Null-as-universal — the `_any` sentinel (the resolved type for
 *      a `null` literal) is compatible with every declared type
 *      *except* `_sequence`. Authors writing
 *      `eq(prop, literal(null))` are filtering for "this property is
 *      unset," which is a valid predicate at every scalar wire target;
 *      rejecting it would force a spurious workaround. Sequences sit
 *      outside the null-as-universal rule because no v1 operator
 *      compares a sequence against any scalar.
 *   2. Numeric promotion — `int` and `decimal` compare freely. Authors
 *      writing `eq(prop("patient", "age"), literal(42))` against a
 *      decimal-typed `age` would otherwise see a spurious mismatch.
 *   3. Select-to-text — `single_select` and `multi_select` are
 *      string-typed under the hood (the schema layer enforces the
 *      enum constraint via `jsonSchema.ts`, not at predicate-check
 *      time), so a literal text comparison against an option's value
 *      is the natural pattern.
 *   4. Sequence isolation — `_sequence` (the `unwrap-list` sentinel)
 *      is incompatible with every other type, including itself.
 *      Sequences don't participate in v1's scalar compatibility
 *      table; the only authoring pattern that consumes a sequence is
 *      the future `selected-any(prop, unwrap-list(...))` CSQL
 *      emission, which routes through a dedicated check rather than
 *      this table. Locking incompatibility universally here means
 *      any v1 author who composes a sequence into a comparison
 *      slot gets a clear "sequence not comparable" error rather than
 *      a silent widening.
 *   5. Same-type — every other pair must match exactly. Date kinds
 *      (`date`, `datetime`, `time`) intentionally don't widen across
 *      each other; the wire targets handle them with distinct
 *      functions, and conflating them produces ambiguous results.
 *
 * The function is symmetric — `typesCompatible(a, b)` always equals
 * `typesCompatible(b, a)` — but we don't enforce that with a helper
 * because the explicit per-pair statements read more clearly than a
 * "canonicalize then compare" detour.
 */
export function typesCompatible(a: ResolvedType, b: ResolvedType): boolean {
	// Sequences sit outside the scalar compatibility table — sequence-
	// vs-anything (including sequence-vs-sequence) is structurally
	// rejected because no v1 operator composes two sequences. Sequence-
	// consuming patterns (the CSQL emitter's `selected-any(prop,
	// unwrap-list(...))` form) route through a dedicated check, not
	// this table.
	if (a === SEQUENCE_TYPE || b === SEQUENCE_TYPE) return false;
	if (a === ANY_TYPE || b === ANY_TYPE) return true;
	if (a === b) return true;
	// int / decimal are mutually comparable.
	if ((a === "int" || a === "decimal") && (b === "int" || b === "decimal"))
		return true;
	// single_select / multi_select compare with text values.
	if (a === "single_select" && b === "text") return true;
	if (a === "text" && b === "single_select") return true;
	if (a === "multi_select" && b === "text") return true;
	if (a === "text" && b === "multi_select") return true;
	return false;
}
