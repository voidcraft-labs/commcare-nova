// lib/domain/predicate/typeChecker.ts
//
// Schema-driven type checker for the predicate AST. Walks a Predicate
// against a TypeContext (derived from the blueprint's CaseType schema and
// the declared search inputs in scope) and produces either Ok or a list
// of typed errors. Errors carry paths so the UI can highlight the
// offending card.
//
// Why a separate type-check pass from `predicateSchema.parse(...)`: the
// Zod schema enforces structural validity (the AST is well-formed) but
// not semantic validity (the operands have compatible data types, the
// referenced property exists on the named case type, the named search
// input is declared at this site). Those rules require the blueprint's
// `CaseType` schema as a side input — they can't be encoded in the AST
// schema itself, which knows nothing about which case types exist. The
// split keeps the AST schema independent of any particular blueprint and
// concentrates the schema-driven rules in this one walker.
//
// This file lands the base structure plus comparison operators. Logical
// (`and`/`or`/`not`), membership (`in`), geo (`within-distance`), fuzzy,
// and conditional (`when-input-present`) operators are added by Tasks 5
// and 6, which extend the dispatch in `walk` and add per-operator
// helpers below. Forward-declared kinds reach the `default:` arm of
// `walk` and are silently accepted at this stage.

import type { CaseProperty, CaseType } from "@/lib/domain";
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
 * Path segments locating the offending operand inside the predicate AST.
 * String segments are field names (`"left"`, `"right"`, `"clause"`);
 * number segments are array indices (e.g. inside an `and`'s `clauses`
 * array). The editor surface uses this path to highlight the failing
 * card without having to reparse the AST itself.
 */
export type CheckPath = (string | number)[];
export type CheckError = { path: CheckPath; message: string };

export type CheckResult = { ok: true } | { ok: false; errors: CheckError[] };

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
const ORDERED_TYPES: ReadonlySet<NonNullable<CaseProperty["data_type"]>> =
	new Set(["int", "decimal", "date", "datetime", "time"]);

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
 * Recursive dispatch on the predicate's discriminator. Each operator
 * gets its own helper rather than one giant switch body — keeps each
 * operator's rules colocated with its dedicated function and makes
 * later tasks' additions a parallel pattern.
 *
 * Exhaustiveness trade-off: the `default:` branch is currently a silent
 * no-op so the comparison-only checker doesn't false-positive against
 * forward-declared kinds (`and`, `or`, `not`, `in`, `within-distance`,
 * `fuzzy`, `when-input-present`). Once Tasks 5 and 6 land, every kind
 * has a dedicated arm and `default:` should become a `never`-style
 * exhaustiveness assertion (`const _exhaustive: never = p`) so adding
 * a new operator forces a parallel update here. Until then, a `never`
 * assertion would block intermediate task commits.
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
			break;
		default:
			break;
	}
}

// ---------- Comparison checking ----------

/**
 * Apply the comparison-operand rules:
 *   1. Both operands' types must resolve. If either operand fails to
 *      resolve (e.g. unknown property, unknown input), `resolveTermType`
 *      pushes the failure and returns `undefined`. We bail before the
 *      compatibility check so the author isn't bombarded with a
 *      cascading "type mismatch" error on top of the real one.
 *   2. For ordering operators (`gt`/`gte`/`lt`/`lte`), both sides must
 *      be in `ORDERED_TYPES`. Strings, selects, and geopoints are
 *      explicitly rejected — see the constant's JSDoc for why.
 *   3. The two resolved types must be comparable per `typesCompatible`.
 *      The compatibility table widens a small set of pairs (numeric
 *      promotion, select-to-text) to keep the type checker out of the
 *      author's way for the most common shapes; everything else fails.
 *
 * Errors accrue on the predicate's own path (`path`), not the operand's
 * (`[...path, "left"]`). The author thinks of "this comparison is
 * wrong", not "the right operand of this comparison is wrong" — we
 * surface the verdict on the comparison itself for clarity, and the
 * operand-resolution errors below already carry their own per-side
 * paths.
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
		if (!ORDERED_TYPES.has(leftType) || !ORDERED_TYPES.has(rightType)) {
			errors.push({
				path,
				message: `Operator '${kind}' requires ordered types (int, decimal, date, datetime, time); got '${leftType}' and '${rightType}'. Strings are not ordered.`,
			});
			return;
		}
	}

	if (!typesCompatible(leftType, rightType)) {
		errors.push({
			path,
			message: `Type mismatch: '${leftType}' and '${rightType}' are not comparable.`,
		});
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
 * `prop.data_type ?? "text"` mirrors `propertyToSchema` in
 * `jsonSchema.ts`: when the blueprint omits a data type, the property
 * is treated as text — CommCare's default for unannotated properties.
 */
function resolveTermType(
	term: Term,
	ctx: TypeContext,
	errors: CheckError[],
	path: CheckPath,
): NonNullable<CaseProperty["data_type"]> | undefined {
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
			// User-context refs always resolve to text. The
			// `instance('commcaresession')/session/user/data/<field>` lookup
			// returns string values regardless of how the author intends to
			// use them — CCHQ's own suite generation tests bind these refs
			// into XPath string comparisons against literal strings (see
			// corehq/apps/app_manager/tests/test_suite_remote_request.py:898,
			// which compares `#session/user/data/is_supervisor` to `'n'`).
			// If an author needs a numeric comparison against a user field,
			// they need to coerce at a layer above this one; here we honor
			// the wire reality.
			return "text";
		case "literal":
			return literalType(term);
	}
}

/**
 * Map a literal's runtime value to its data type. Numeric literals are
 * narrowed to `int` vs `decimal` via `Number.isInteger` so an `eq` that
 * compares a `decimal` property to `42` (an int literal) still passes
 * via the numeric-promotion rule in `typesCompatible`, while a `decimal`
 * compared to `42.5` resolves precisely.
 *
 * String literals get a structural ISO-format sniff so an author writing
 * `lt(prop("patient", "dob"), literal("2000-01-01"))` resolves the
 * literal as `date` and passes the ordering rule. Without this, every
 * date / datetime / time literal would resolve to `text`, the
 * comparison would fail the `ORDERED_TYPES` check, and the author would
 * be forced to invent a non-string literal kind for what is normally a
 * one-liner. The strict format enforcement (range checks, leap-day
 * validity, etc.) lives at the schema-emit layer in `jsonSchema.ts`;
 * here we only need enough structure to pick the right comparison
 * rule, and the patterns below are the cheapest signal that suffices.
 *
 * Booleans and `null` both resolve to `text`. CommCare booleans on the
 * wire are text-encoded (`'true'` / `'false'`), and `null` is comparable
 * against any text-typed property as a sentinel for "unset". The two
 * unusual cases share the `text` resolution so the comparison rules
 * don't have to special-case either.
 */

// ISO-shape sniffs for string literals. Loose by design — the strict
// format validators run at wire-emission time. Anchored at both ends so
// embedded matches (e.g. a comment field that happens to contain a date
// substring) don't false-positive.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const ISO_TIME = /^\d{2}:\d{2}(:\d{2})?$/;

function literalType(lit: Literal): NonNullable<CaseProperty["data_type"]> {
	switch (typeof lit.value) {
		case "string":
			if (ISO_DATETIME.test(lit.value)) return "datetime";
			if (ISO_DATE.test(lit.value)) return "date";
			if (ISO_TIME.test(lit.value)) return "time";
			return "text";
		case "number":
			return Number.isInteger(lit.value) ? "int" : "decimal";
		case "boolean":
			return "text";
		case "object":
			return "text"; // null
	}
}

// ---------- Compatibility table ----------

/**
 * Decide whether two resolved types may participate in a comparison.
 * Three classes of widening are in play:
 *   1. Numeric promotion — `int` and `decimal` compare freely. Authors
 *      writing `eq(prop("patient", "age"), literal(42))` against a
 *      decimal-typed `age` would otherwise see a spurious mismatch.
 *   2. Select-to-text — `single_select` and `multi_select` are
 *      string-typed under the hood (the schema layer enforces the
 *      enum constraint via `jsonSchema.ts`, not at predicate-check
 *      time), so a literal text comparison against an option's value
 *      is the natural pattern.
 *   3. Same-type — every other pair must match exactly. Date kinds
 *      (`date`, `datetime`, `time`) intentionally don't widen across
 *      each other; the wire targets handle them with distinct
 *      functions, and conflating them produces ambiguous results.
 *
 * The function is symmetric — `typesCompatible(a, b)` always equals
 * `typesCompatible(b, a)` — but we don't enforce that with a helper
 * because the explicit per-pair statements read more clearly than a
 * "canonicalize then compare" detour.
 */
function typesCompatible(
	a: NonNullable<CaseProperty["data_type"]>,
	b: NonNullable<CaseProperty["data_type"]>,
): boolean {
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
