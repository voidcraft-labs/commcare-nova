// lib/domain/predicate/typeChecker.ts
//
// Schema-driven type checker for the predicate AST. `checkPredicate(p,
// ctx)` walks a Predicate against a TypeContext (the blueprint's
// CaseType schema and the search inputs in scope) and produces either
// Ok or a list of typed errors. Each error carries a path that locates
// the offending node so the editor can highlight the failing card
// without having to reparse the AST itself.
//
// Why a separate type-check pass from `predicateSchema.parse(...)`: the
// Zod schema enforces structural validity (the AST is well-formed) but
// not semantic validity (the operands have compatible data types, the
// referenced property exists on the named case type, the named search
// input is declared at this site). Those rules require the blueprint's
// `CaseType` schema as a side input — they can't be encoded in the AST
// schema itself, which knows nothing about which case types exist. The
// split keeps the AST schema independent of any particular blueprint
// and concentrates the schema-driven rules in this one walker.
//
// Walk dispatch: comparison operators (`eq` / `neq` / `gt` / `gte` /
// `lt` / `lte`) check operand-type compatibility against the resolution
// rules below. Logical wrappers (`and` / `or` / `not`) recurse into
// their child clauses, threading the operator name and (for the
// multi-clause arms) the array index into the error path so a
// violation buried inside a logical wrapper still surfaces with a
// precise location. `when-input-present` recurses into its wrapped
// `clause`. Membership (`in`), geo (`within-distance`), and fuzzy
// (`fuzzy`) carry no nested predicates and their structural shape is
// validated at parse time, so the walker descends past them without
// further inspection. Any per-operator semantic check belongs in its
// own dispatch arm, colocated with the kind's case label, so adding a
// rule extends the dispatch table rather than threading a new branch
// through the comparison-rule code.

import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import type { ComparisonKind, Literal, Predicate, Term } from "./types";

// ---------- Types ----------

/**
 * Declared search input in scope at the type-check site. The case-search
 * UI declares inputs at the screen level; predicates referencing
 * `input(name)` resolve against this list. The optional `data_type`
 * widens or narrows the comparison-rule check at this input's use site
 * — when omitted, the input defaults to `text`, which is CommCare's
 * default for properties without an explicit type.
 */
export type SearchInputDecl = {
	kind: "input";
	name: string;
	data_type?: CaseProperty["data_type"];
};

/**
 * The schema-derived context the checker validates a predicate against.
 * Composed at the call site from the blueprint (`caseTypes`) and the
 * search-screen's declared inputs (`knownInputs`). `currentCaseType` is
 * carried for downstream consumers that need it (e.g. the SQL compiler's
 * default-table resolution); the type checker itself reads it only for
 * future operator coverage that may default an unqualified property
 * reference to the current case type.
 */
export type TypeContext = {
	caseTypes: CaseType[];
	currentCaseType: string;
	knownInputs: SearchInputDecl[];
};

/**
 * Path segments locating the offending node inside the predicate AST.
 * The walker emits paths under one consistent convention so consumers
 * (the editor's highlight logic, debug output) can decode them
 * uniformly:
 *
 *   - Comparison operands — `[..., "left"]` / `[..., "right"]`. The
 *     comparison operator itself doesn't add a segment; resolution
 *     errors land directly on the operand.
 *   - Comparison operator-level errors (ordered-types check,
 *     compatibility mismatch) — emitted on the predicate's own path,
 *     no operator-name segment, since the verdict belongs to the
 *     comparison node itself.
 *   - Unary wrappers (`not`, `when-input-present`) — `[..., "<kind>",
 *     "clause"]`. The operator name + field name shape disambiguates
 *     a clause inside `not` from a clause inside a sibling `when-
 *     input-present` and signals which slot inside the operator the
 *     error came from.
 *   - Multi-clause wrappers (`and`, `or`) — `[..., "<kind>", <index>]`.
 *     The operator name disambiguates between sibling collections;
 *     the numeric index identifies the failing clause within. Number
 *     segments only ever appear as array indices — string-then-number
 *     uniformly means "the n-th element of that collection."
 *
 * Consumers branching on segment shape can therefore use a uniform
 * rule: if the next segment is a number, it's an array index;
 * otherwise it's a field or operator name. The trade-off keeps paths
 * short and human-readable in the editor's debug output.
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
 * `CheckError.message`, never returned by a public function. The leading
 * underscore is the convention for "internal type sentinel" and pairs
 * with `casePropertyDataTypes` in the blueprint to keep the public
 * surface clean.
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

// ---------- Top-level walker ----------

/**
 * Validate a predicate against the supplied context. Pure — no I/O, no
 * side effects, the input AST is never mutated. Errors accumulate
 * across the whole walk so the editor can surface every issue in one
 * pass rather than forcing the author through one-error-at-a-time
 * fix-and-retry cycles.
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
			walk(p.clause, ctx, errors, [...path, "not", "clause"]);
			return;
		case "when-input-present":
			// Descend into the wrapped clause so any comparison-rule
			// violations inside it surface here. Validating the `input`
			// reference itself against `ctx.knownInputs` is a separate
			// concern from descending into the wrapped clause; the
			// dispatch arm for that check stays colocated with this
			// kind so both responsibilities for `when-input-present`
			// live in one place.
			walk(p.clause, ctx, errors, [...path, "when-input-present", "clause"]);
			return;
		case "in":
		case "within-distance":
		case "fuzzy":
			// These kinds carry no nested predicates and their structural
			// shape is validated at parse time, so descending without
			// inspection is safe. Per-operator semantic checks
			// (membership-value type, geo-property type, fuzzy-property
			// type) belong in their own dispatch arms, colocated with
			// the kind's case label so the dispatch table stays the
			// single index for "what does this checker do for kind X."
			return;
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
			// string at the XPath/CSQL layer, and authors who need typed
			// comparisons against a user field today coerce upstream of the
			// type checker. Symmetric with `SearchInputDecl`'s optional
			// `data_type`, this convention can be relaxed by extending
			// `UserContextRef` to carry a declared type — that's a
			// deliberate non-goal at the foundation stage. (CCHQ wire
			// example: see references to `#session/user/data/...` in
			// `corehq/apps/app_manager/tests/test_suite_remote_request.py`.)
			return "text";
		case "literal":
			return literalType(term);
	}
}

/**
 * Map a literal to its data type. Three resolution sources, in order:
 *   1. `lit.data_type` — explicit, set by the typed builders
 *      (`dateLiteral` / `datetimeLiteral` / `timeLiteral` /
 *      future-typed-literal-builders). Wins unconditionally because
 *      the author has already declared the semantic type.
 *   2. `null` value — resolves to the internal `_any` sentinel so it
 *      compares against any declared property type. See `ANY_TYPE`'s
 *      JSDoc for the rationale.
 *   3. JS runtime type — for untyped literals, infer from the JS value:
 *      strings become `text`, numbers split int / decimal via
 *      `Number.isInteger` (so the numeric-promotion rule in
 *      `typesCompatible` handles `int` / `decimal` interchangeably),
 *      booleans become `text`. Boolean-as-text is consistent with the
 *      case-block XML wire format, where every property value is
 *      stringified at serialization (see
 *      corehq/ex-submodules/casexml/apps/case/mock/case_block.py:246-256
 *      — `_DictToXML.fmt` runs `six.text_type(value)` on every
 *      non-`None` non-bytes value, including booleans). The XForm /
 *      CSQL value-coercion layer above the case-block boundary may
 *      apply further normalization at evaluation time; this checker
 *      does not depend on its exact form.
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
