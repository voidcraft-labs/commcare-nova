// lib/commcare/predicate/xpathEmitter.ts
//
// Compile a predicate AST to a CommCare-compatible XPath/CSQL string.
//
// Two emission contexts are exposed:
//
//   - case-list-filter — predicate dropped inside the case-list nodeset
//     (e.g. `instance('casedb')/casedb/case[...][<this>]`). Property
//     references emit as bare names; the case-type scope is implied by
//     the surrounding nodeset.
//   - csql — predicate placed inside a `_xpath_query` value during case
//     search. Property references emit as bare names here too; runtime
//     concatenation against search-input instances happens at the wire
//     layer, not here.
//
// Both contexts share every operator emission and quoting rule. They
// diverge only at the wire-wrapping layer outside this file. The
// emitter still threads the context through every recursive call so
// any operator arm whose wire form is context-dependent can branch on
// it without changing the public signature.
//
// Comparison and logical operators have direct wire forms emitted
// here. The special operators (`in` / `within-distance` / `fuzzy` /
// `when-input-present`) have a dedicated arm in the switch that
// throws — the explicit case keeps exhaustiveness against the
// predicate union, so adding a new AST kind without an emission arm
// surfaces as a TypeScript error at this file rather than a runtime
// fall-through.
//
// CCHQ wire-form citations (production paths in commcare-hq):
//
//   - `instance('search-input:results')/input/field[@name='<n>']`
//     for search-input refs — see
//     `docs/case_search_query_language.rst:299` (the canonical
//     subcase-exists/`when-input-present` example) and the
//     instance-factory registration at
//     `corehq/apps/app_manager/suite_xml/post_process/instances.py:354`.
//   - `instance('commcaresession')/session/user/data/<field>` for
//     user-context refs — see
//     `corehq/apps/app_manager/xpath_validator/tests.py:38` (the
//     canonical commcare_location_id example) and the suite fixture
//     at `corehq/apps/app_manager/tests/data/suite/suite-advanced-autoselect-user.xml:12`.
//   - `concat('a', "'", 'b')` as the embedded-quote escape — XPath 1.0
//     has no string-escape syntax, so the portable form switches to
//     `concat()` with alternating quote styles. `concat()` is a core
//     XPath 1.0 function and is accepted unmodified by the CommCare
//     XPath dialect; the project's own grammar tests round-trip the
//     same form (`lib/commcare/__tests__/deepValidation.test.ts:24`).

import type { Predicate, Term } from "@/lib/domain/predicate/types";

/**
 * Two surfaces consume this emitter's output. The wire-wrapping layer
 * outside this file decides how the resulting string is embedded —
 * dropped into a nodeset for `case-list-filter`, concatenated into a
 * `_xpath_query` template for `csql`. The operator emission rules are
 * identical across both contexts at this layer.
 */
export type EmissionContext = "case-list-filter" | "csql";

/**
 * Mapping from comparison-operator AST kind to its XPath wire token.
 * The six comparison operators share an identical emission shape
 * (`<left> <op> <right>`), so the emitter dispatches off this table
 * rather than restating six near-identical cases.
 */
const COMPARISON_OPS: Record<string, string> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

// Operator-precedence levels for paren-grouping decisions: higher
// binds tighter. The recursive walker passes its own level down as
// `parentPrec`, and a child whose level is lower than `parentPrec`
// wraps itself in parens to preserve the authored grouping. XPath's
// own precedence (`and` tighter than `or`) drives the two values.
// Comparisons hold no slot here because they are leaves at this layer
// — their operands are terms, not predicates, so they never wrap a
// child predicate.
const PREC_OR = 1;
const PREC_AND = 2;

/**
 * Compile `p` to a CommCare-compatible XPath/CSQL string. The starting
 * `parentPrec` is `0` so the outermost predicate is never wrapped in
 * parens — only nested operators trigger grouping.
 */
export function emitXPath(p: Predicate, ctx: EmissionContext): string {
	return emitPredicate(p, ctx, 0);
}

/**
 * Recursive walker. Each operator arm consults `parentPrec` to decide
 * whether its emitted string needs to be wrapped in parens to preserve
 * the authored grouping when the parent binds tighter than this
 * operator. Leaf operators (comparisons) ignore `parentPrec` — they
 * never produce a parsing ambiguity at this layer because their
 * operands are terms, not predicates.
 */
function emitPredicate(
	p: Predicate,
	ctx: EmissionContext,
	parentPrec: number,
): string {
	switch (p.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return `${emitTerm(p.left, ctx)} ${COMPARISON_OPS[p.kind]} ${emitTerm(p.right, ctx)}`;
		case "and": {
			// `and` clauses recurse with `PREC_AND` as their parent
			// precedence, so any `or` nested inside an `and` clause
			// will wrap itself in parens — XPath's `and` binds tighter
			// than `or`, and emitting `A or B and C` would
			// re-associate as `A or (B and C)` rather than the
			// authored `(A or B) and C`.
			const inner = p.clauses
				.map((c) => emitPredicate(c, ctx, PREC_AND))
				.join(" and ");
			return parentPrec > PREC_AND ? `(${inner})` : inner;
		}
		case "or": {
			// `or` clauses recurse with `PREC_OR` (the lowest level),
			// so nested `and` / comparison sub-expressions never need
			// to group beneath an `or` — XPath's precedence already
			// resolves them correctly without parens.
			const inner = p.clauses
				.map((c) => emitPredicate(c, ctx, PREC_OR))
				.join(" or ");
			return parentPrec > PREC_OR ? `(${inner})` : inner;
		}
		case "not":
			// `not()` is an XPath function call, not a prefix
			// operator; the parens around the inner are the
			// function-call argument list. Pass `parentPrec` of `0` so
			// the inner never adds redundant grouping.
			return `not(${emitPredicate(p.clause, ctx, 0)})`;
		case "in":
		case "within-distance":
		case "fuzzy":
		case "when-input-present":
			// Special-operator arm. Listed explicitly (rather than
			// folded into a default) so the switch is exhaustive
			// against the predicate union — adding a new AST kind
			// without a matching emission arm surfaces here as a
			// TypeScript error at compile time rather than a silent
			// runtime fall-through. The runtime throw fires only if
			// the AST passes type checks but no implementation arm
			// exists for one of these kinds.
			throw new Error(
				`emitXPath: operator '${p.kind}' has no emission arm in this module.`,
			);
	}
}

/**
 * Compile a term to its wire form. The two CommCare instance paths
 * (search-input and commcaresession) are emitted as raw strings rather
 * than constructed via a path builder — this is the one place where
 * the emitter speaks the literal CommCare vocabulary, and putting the
 * paths inline keeps the wire form readable next to the citations in
 * the file header. The `_ctx` argument carries the emission context so
 * any operator arm whose wire form depends on context (e.g. a
 * surface-specific quoting rule) can consult it without changing this
 * signature.
 */
function emitTerm(term: Term, _ctx: EmissionContext): string {
	switch (term.kind) {
		case "prop":
			// Bare property name. The case-type scope is implied by
			// the surrounding nodeset (case-list-filter sits inside a
			// `casedb/case[...]` predicate; csql is scoped at query
			// time), so the emitter never threads the `caseType`
			// qualifier into the output.
			return term.property;
		case "input":
			return `instance('search-input:results')/input/field[@name='${term.name}']`;
		case "user":
			return `instance('commcaresession')/session/user/data/${term.field}`;
		case "literal":
			return emitLiteral(term.value);
	}
}

/**
 * Compile a primitive literal to its wire form. Numbers emit as
 * unquoted XPath numbers; booleans emit as the strings `'true'` /
 * `'false'` (CommCare's case-search wire treats stored booleans as
 * strings — the case database stores everything as text). `null`
 * emits as the empty string `''`, matching the structural sentinel
 * used by the type checker for "is unset" comparisons.
 *
 * Strings emit as single-quoted XPath strings; an embedded single
 * quote forces a `concat()` fallback because XPath 1.0 has no
 * string-escape syntax. The fallback alternates single- and
 * double-quoted segments so the embedded quote stays unambiguous to
 * the parser.
 */
function emitLiteral(value: string | number | boolean | null): string {
	if (value === null) return "''";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "'true'" : "'false'";
	if (!value.includes("'")) return `'${value}'`;
	const parts = value.split("'");
	const args: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		args.push(`'${parts[i]}'`);
		if (i < parts.length - 1) args.push(`"'"`);
	}
	return `concat(${args.join(", ")})`;
}
