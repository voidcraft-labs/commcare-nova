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
// named search input is declared, user-context refs and literals
// resolve to their data type) runs uniformly across every operator
// that carries term operands — comparisons, the trigger-input slot of
// `when-input-present`, and the term operands of `in` /
// `within-distance` / `match` / `multi-select-contains`. Operand-type
// compatibility (the "comparable types" check between resolved operand
// types) runs for the comparison operators (`eq` / `neq` / `gt` /
// `gte` / `lt` / `lte`) and for `in`'s and `multi-select-contains`'s
// membership values (every literal in `values` is checked for type
// compatibility against the resolved property type). Per-operator
// semantic checks beyond resolution + compatibility run in dedicated
// arms: `within-distance` requires the `property` slot to resolve to
// `geopoint` and the `center` slot to resolve to `geopoint` or `text`
// (the wire-form coordinate string is text); `match` requires the
// `property` slot to resolve to one of the text-shaped data types
// (`text` / `single_select` / `multi_select`) across all four modes;
// `multi-select-contains` requires the `property` slot to resolve to
// `multi_select` specifically (a Nova authoring policy stricter than
// CCHQ's wire-layer dispatch — see `checkMultiSelectContains` for the
// rationale). Logical wrappers (`and` / `or` / `not`) and the wrapped
// clause of `when-input-present` recurse so violations inside them
// surface here, with paths threading the operator name and (for the
// multi-clause arms) the array index.

import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import type { ComparisonKind, Literal, Predicate, Term } from "./types";

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
 * Composed at the call site from the blueprint (`caseTypes`) and the
 * search-screen's declared inputs (`knownInputs`). Property references
 * carry their own `caseType` qualifier on `PropertyRef`, so the
 * checker has no notion of a "current" case type — every reference
 * resolves against `caseTypes` directly by name.
 */
export type TypeContext = {
	caseTypes: CaseType[];
	knownInputs: SearchInputDecl[];
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
 * Internal sentinel for the `null` literal — comparable against any
 * declared property type. Authors writing
 * `eq(prop("patient", "age"), literal(null))` are asking "is this
 * property unset", which is a valid predicate at every wire target;
 * resolving the null literal to a concrete data type would force a
 * spurious type-mismatch error every time. The sentinel short-circuits
 * both the ordered-types check in `checkComparison` and the
 * compatibility table in `typesCompatible`.
 *
 * Kept module-private — never exposed on the AST, never appears in
 * `CheckError.message`, never returned by a public function. The
 * `describe(...)` helper renders it as `"null"` for any error
 * message that would otherwise interpolate the resolved type.
 */
const ANY_TYPE = "_any" as const;

// Internal-only resolved type. The `_any` member is the null-sentinel
// described above and must never appear on a public surface — do not
// export this type. Public callers consume the type checker via
// `CheckResult` (which pre-formats sentinels into user-readable
// strings via `describe(...)` before they reach `CheckError.message`).
type ResolvedType = CasePropertyDataType | typeof ANY_TYPE;

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
const ORDERED_TYPES: ReadonlySet<CasePropertyDataType> = new Set([
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
]);

// Property types the `match` operator accepts across all four modes
// (`fuzzy` / `phonetic` / `fuzzy-date` / `starts-with`). Text-shaped
// types pass through CCHQ's `case_property_query` (used by
// `fuzzy-match`, `_selected_query`, and `fuzzy-date` per
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-115`)
// and `case_property_starts_with` (used by `starts-with` per
// `commcare-hq/corehq/apps/es/case_search.py:312-323`). Both functions
// dispatch text / single_select / multi_select through the same
// underlying ES path on the `PROPERTY_VALUE` / `PROPERTY_VALUE_EXACT`
// field, so the allow-list is shared across every match mode.
const MATCH_PROPERTY_TYPES: ReadonlySet<CasePropertyDataType> = new Set([
	"text",
	"single_select",
	"multi_select",
]);

// ---------- Top-level walker ----------

/**
 * Validate a predicate against the supplied context. Pure — no I/O, no
 * side effects, the input AST is never mutated. Errors accumulate
 * across the whole walk so the editor can surface every issue in one
 * pass rather than forcing the author through one-error-at-a-time
 * fix-and-retry cycles.
 *
 * Throws synchronously when the walk reaches a kind without dedicated
 * semantic rules — `is-null`, `between`, `exists`, `missing`.
 * The throw also fires when one of those kinds is nested inside a
 * logical wrapper (`and` / `or` / `not` / `when-input-present`) —
 * e.g. `and(eq(...), isNull(...))` — because the walker recurses
 * through the wrapper's clauses before it dispatches on the inner
 * kind.
 *
 * Throwing prevents those kinds from silently producing false-positive
 * "type-checks clean" verdicts on unchecked predicates, the exact
 * failure mode the checker exists to prevent. Callers either handle
 * the throw or scope inputs to the kinds with rules.
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
		case "between":
		case "exists":
		case "missing":
			// These four kinds have no dedicated semantic rules in this
			// checker; the walker throws to prevent silent type-clean
			// verdicts on unchecked predicates (the failure mode the
			// checker itself exists to prevent). The walker also does
			// not recurse into these kinds' operand slots
			// (`exists.where` / `missing.where` for predicate
			// recursion, `between.lower` / `between.upper` /
			// `is-null.left` for term resolution) — operand walking
			// belongs with the per-kind rule that interprets those
			// operands, so both move together rather than walking
			// without a rule to apply at the leaves.
			throw new Error(`checkPredicate: no rules for kind '${p.kind}'`);
		default: {
			// Exhaustiveness assertion — adding a new kind to `Predicate`
			// without a parallel arm here breaks the build. The runtime
			// throw guards the same invariant for any payload that reaches
			// this branch via untyped boundaries.
			const _exhaustive: never = p;
			throw new Error(
				`checkPredicate: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ---------- Comparison checking ----------

/**
 * Apply the comparison-operand rules:
 *   1. Both operands' types must resolve. If either operand fails to
 *      resolve (e.g. unknown property, unknown input), `resolveTermType`
 *      pushes the failure on the operand's own path and returns
 *      `undefined`. We bail before the compatibility check so the
 *      author isn't bombarded with a cascading "type mismatch" error
 *      on top of the real one.
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
 */
function checkComparison(
	kind: ComparisonKind,
	left: Term,
	right: Term,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): void {
	const leftType = resolveTermType(left, ctx, errors, [...path, "left"]);
	const rightType = resolveTermType(right, ctx, errors, [...path, "right"]);
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
 * Hides the internal `_any` sentinel — null literals appear as `null`
 * in the author's source, so that's the friendliest framing in the
 * error too.
 */
function describe(t: ResolvedType): string {
	return t === ANY_TYPE ? "null" : t;
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
	const leftType = resolveTermType(p.left, ctx, errors, [...path, "left"]);
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
	const centerType = resolveTermType(p.center, ctx, errors, [
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
 * Text-shape requirement on `match.property` across all four modes
 * (`fuzzy` / `phonetic` / `fuzzy-date` / `starts-with`). CommCare's
 * wire layer dispatches every mode through `case_property_query` (for
 * `fuzzy-match` / `_selected_query` / `fuzzy-date` per
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-115`)
 * or `case_property_starts_with` (for `starts-with` per
 * `commcare-hq/corehq/apps/es/case_search.py:312-323`). Both reach the
 * same property-value field on the Elasticsearch index regardless of
 * declared type, so this rule isn't a CCHQ structural enforcement —
 * it's a Nova UX policy. Text-match semantics against an int, a
 * decimal, a date, or a geopoint produce no useful results (edit-
 * distance, phonetic equivalence, and prefix matching are all defined
 * on character strings, not on numeric / temporal / coordinate
 * values); the type checker rejects those property types so the
 * author can't construct a predicate that compiles but never produces
 * a useful match.
 *
 * Why text-shaped types — `text`, `single_select`, `multi_select` —
 * pass the allow-list: on CCHQ's wire, single-select values serialize
 * as plain strings and multi-select values as space-separated strings
 * in the same property-value field that text uses
 * (`selected-any(tags, "vip urgent")` is the canonical multi-select
 * filter shape, and `_selected_query` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-51`
 * dispatches all three through the same `case_property_query` that
 * `fuzzy-match` itself uses). Text-matching against a select property
 * therefore matches by the same Elasticsearch mechanism as
 * text-matching against a text property — the allow-list is identical
 * across the four modes; narrowing any one mode to text-only would
 * diverge from CCHQ's shared dispatch.
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
	// `ANY_TYPE` is structurally unreachable for a `PropertyRef` today,
	// but the explicit guard pins the invariant at the type system: a
	// future widening of the match schema's operand or of
	// `resolveTermType`'s null handling fails the
	// `CasePropertyDataType`-typed `has` lookup at compile time
	// instead of silently treating `_any` as "passes the allow-list."
	if (
		propType !== undefined &&
		propType !== ANY_TYPE &&
		!MATCH_PROPERTY_TYPES.has(propType)
	) {
		errors.push({
			path: [...path, "property"],
			message: `match requires a text-typed property (text, single_select, or multi_select); got '${describe(propType)}'.`,
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
function resolveTermType(
	term: Term,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): ResolvedType | undefined {
	switch (term.kind) {
		case "prop": {
			// `via` carries a relation walk (`ancestor` / `subcase` /
			// `any-relation`) whose resolution rule — "look up `property`
			// on the destination case type, not on `caseType`" — is the
			// destination-scope check. The walker has the originating-
			// scope check below ("does `property` exist on `caseType`?"),
			// but no rule for the destination scope, so emitting an
			// error here is the right level of loudness: the rest of
			// the predicate still gets walked (matching the
			// unknown-property / unknown-input policy in the arms
			// below) and the verdict comes back as `{ ok: false }` with
			// a clear message rather than a silent type-clean
			// false-positive on a cross-type traversal that wasn't
			// validated. `{ kind: "self" }` is the explicit
			// no-traversal form (semantically equivalent to absent
			// `via`), so it routes through the originating-scope check
			// without an error.
			if (term.via !== undefined && term.via.kind !== "self") {
				errors.push({
					path,
					message: `Property reference uses 'via: ${term.via.kind}' — type-checker resolution through relation walks has no dedicated rule. The originating-scope check (does '${term.property}' exist on '${term.caseType}'?) is structural; checking the destination scope is a separate concern.`,
				});
				return undefined;
			}
			const ct = ctx.caseTypes.find((c) => c.name === term.caseType);
			if (!ct) {
				errors.push({
					path,
					message: `Unknown case type '${term.caseType}'.`,
				});
				return undefined;
			}
			const property = ct.properties.find((p) => p.name === term.property);
			if (!property) {
				errors.push({
					path,
					message: `Unknown property '${term.property}' on case type '${term.caseType}'.`,
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
		case "user":
			// User-context refs resolve to text by convention. CommCare's
			// `instance('commcaresession')/session/user/data/<field>` returns a
			// string at the XPath/CSQL layer; the type checker treats user
			// fields as text without an opt-out path. The only resolution
			// path is text; any typed coercion happens upstream of the
			// predicate.
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
				`resolveTermType: unhandled term kind ${String(_exhaustive)}`,
			);
		}
	}
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
function literalType(lit: Literal): ResolvedType {
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
				`literalType: unhandled literal value type ${String(_exhaustive)}`,
			);
		}
	}
}

// ---------- Compatibility table ----------

/**
 * Decide whether two resolved types may participate in a comparison.
 * Four classes of widening are in play:
 *   1. Null-as-universal — the `_any` sentinel (the resolved type for
 *      a `null` literal) is compatible with every declared type.
 *      Authors writing `eq(prop, literal(null))` are filtering for
 *      "this property is unset," which is a valid predicate at every
 *      wire target; rejecting it would force a spurious workaround.
 *   2. Numeric promotion — `int` and `decimal` compare freely. Authors
 *      writing `eq(prop("patient", "age"), literal(42))` against a
 *      decimal-typed `age` would otherwise see a spurious mismatch.
 *   3. Select-to-text — `single_select` and `multi_select` are
 *      string-typed under the hood (the schema layer enforces the
 *      enum constraint via `jsonSchema.ts`, not at predicate-check
 *      time), so a literal text comparison against an option's value
 *      is the natural pattern.
 *   4. Same-type — every other pair must match exactly. Date kinds
 *      (`date`, `datetime`, `time`) intentionally don't widen across
 *      each other; the wire targets handle them with distinct
 *      functions, and conflating them produces ambiguous results.
 *
 * The function is symmetric — `typesCompatible(a, b)` always equals
 * `typesCompatible(b, a)` — but we don't enforce that with a helper
 * because the explicit per-pair statements read more clearly than a
 * "canonicalize then compare" detour.
 */
function typesCompatible(a: ResolvedType, b: ResolvedType): boolean {
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
