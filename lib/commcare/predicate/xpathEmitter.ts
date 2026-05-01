// lib/commcare/predicate/xpathEmitter.ts
//
// Compile a predicate AST to a CommCare-compatible XPath/CSQL string.
//
// Two emission contexts diverge in their string-literal escape
// strategy because the available escape mechanisms differ at each
// surface:
//
//   - case-list-filter — the emitted string is dropped directly into
//     a case-list nodeset predicate
//     (e.g. `instance('casedb')/casedb/case[<this>]`). Standard XPath
//     1.0 is in scope, including string-building functions like
//     `concat()`, so embedded single quotes resolve via a
//     `concat('part', "'", 'part')` fallback that the XPath 1.0
//     grammar admits directly.
//   - csql — the emitted string is the inner predicate inside a CSQL
//     `_xpath_query` value evaluated by ElasticSearch. CSQL's
//     value-function whitelist excludes `concat()` (verified at
//     `corehq/apps/case_search/xpath_functions/__init__.py:27-36`,
//     where `XPATH_VALUE_FUNCTIONS` lists 8 functions and `concat`
//     is not among them; comparison-RHS values pass through
//     `unwrap_value` at `corehq/apps/case_search/dsl_utils.py:32-40`,
//     which raises `CaseFilterError` on any function name outside
//     that whitelist). The emitter therefore switches between
//     single- and double-quoted string literals to handle embedded
//     quotes and rejects values containing both quote styles because
//     no portable inline escape exists in CSQL.
//
// Comparison + logical operator emission, identifier rules, the
// reserved-attribute prefix set, and numeric-literal handling are
// identical across both contexts; divergence is concentrated in the
// string-literal escape path. The emitter threads the context
// through every recursive call so the literal-escape arm can branch
// without changing the public signature.
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
//   - `concat('a', "'", 'b')` as the case-list-filter embedded-quote
//     escape — XPath 1.0 has no string-escape syntax, so the portable
//     form switches to `concat()` with alternating quote styles. The
//     CommCare XPath grammar at
//     `lib/commcare/xpath/grammar.lezer.grammar:128-131` admits both
//     single- and double-quoted string literals as `concat()`
//     arguments.
//   - Double-quoted CSQL string literals — see
//     `docs/case_search_query_language.rst:417` for the canonical
//     post-`concat()` CSQL string example, where every property
//     value is double-quoted (`@case_type = "service"`,
//     `@status != "closed"`, etc.).

import type {
	ComparisonKind,
	Predicate,
	Term,
} from "@/lib/domain/predicate/types";

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
 * rather than restating six near-identical cases. Typed by
 * `ComparisonKind` so adding a new comparison kind to the AST surfaces
 * here as a TypeScript error until the wire token is added — keeps
 * the table exhaustive against the union.
 */
const COMPARISON_OPS: Record<ComparisonKind, string> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

/**
 * The four CommCare case properties that CCHQ stores as XML
 * attributes on `<case>` in the casedb restore output. XPath
 * accesses them via the `@` prefix because that is the syntax for
 * addressing XML attributes; the `@` is not a generic CommCare
 * convention but a literal XML-attribute access.
 *
 * CSQL recognizes these same four names with the `@` prefix in
 * `INDEXED_METADATA_BY_KEY`, routing them as system metadata rather
 * than user properties — so a bare `case_type` in CSQL silently
 * degrades to a user-property lookup with no match. The other six
 * CSQL system-metadata keys (`name`, `case_name`, `external_id`,
 * `date_opened`, `closed_on`, `last_modified`) are registered
 * without the prefix and appear on the wire as `<case>` child
 * elements (case-list-filter) or as bare names (CSQL); they are
 * deliberately not in this set.
 *
 * Sources (production code, not tests):
 *
 *   - `corehq/ex-submodules/casexml/apps/case/xml/generator.py:240-245`
 *     — `CaseDBXMLGenerator.get_root_element()` sets exactly these
 *     four as XML attributes on `<case>`; everything else is
 *     emitted as a child element.
 *   - `corehq/apps/case_search/const.py:53-103` —
 *     `INDEXED_METADATA_BY_KEY` registers ten system metadata keys;
 *     the four below carry the `@` prefix, the other six do not.
 */
const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

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
 * the file header. `ctx` flows through to the `literal` arm so the
 * string-escape strategy can branch on context.
 */
function emitTerm(term: Term, ctx: EmissionContext): string {
	switch (term.kind) {
		case "prop": {
			// Reserved CommCare case properties are addressed with the
			// `@` prefix in both case-list-filter and csql contexts;
			// see RESERVED_CASE_ATTRIBUTES for the source citations.
			//
			// The case-type qualifier (`term.caseType`) is dropped at
			// this layer — every property reference emits the same
			// wire form regardless of which case type the AST names.
			// The wire-correct case type is whichever one the
			// surrounding nodeset (case-list-filter) or search context
			// (csql) selects at execution time. The type checker does
			// NOT verify that `term.caseType` matches that surrounding
			// context, so callers are responsible for keeping the AST
			// qualifier aligned with the wire scope where the
			// predicate is dropped. Cross-case-type traversal (parent
			// or host index navigation) is a separate AST shape with
			// its own wire form; the bare property reference always
			// resolves against the immediate surrounding scope.
			if (RESERVED_CASE_ATTRIBUTES.has(term.property)) {
				return `@${term.property}`;
			}
			return term.property;
		}
		case "input":
			return `instance('search-input:results')/input/field[@name='${term.name}']`;
		case "user":
			return `instance('commcaresession')/session/user/data/${term.field}`;
		case "literal":
			return emitLiteral(term.value, ctx);
	}
}

/**
 * Compile a primitive literal to its wire form. Numbers emit as
 * unquoted XPath numbers via `emitNumericLiteral` — see that helper
 * for the scientific-notation handling. Booleans emit as the strings
 * `'true'` / `'false'`; CommCare's case-property storage isn't
 * strongly typed and the wire form a boolean takes depends on what
 * the originating form wrote, so authors who need a different
 * canonicalization (`'1'` / `'0'`, `'yes'` / `'no'`) coerce upstream
 * by passing a string literal explicitly. `null` emits as the empty
 * string `''` because XPath compares an absent attribute equal to
 * `''`, so `<prop> = ''` is the natural "is unset" form.
 *
 * String literals delegate to `emitStringLiteral` because the escape
 * strategy depends on the emission context — case-list-filter has
 * `concat()` available as the alternating-quote fallback, while CSQL
 * does not.
 */
function emitLiteral(
	value: string | number | boolean | null,
	ctx: EmissionContext,
): string {
	if (value === null) return "''";
	if (typeof value === "number") return emitNumericLiteral(value);
	if (typeof value === "boolean") return value ? "'true'" : "'false'";
	return emitStringLiteral(value, ctx);
}

/**
 * Compile a string literal to its wire form, branching on context
 * for the embedded-quote escape:
 *
 *   - When the value contains no single quote, both contexts emit
 *     `'<value>'` — the common case, with no divergence.
 *   - In `case-list-filter`, an embedded single quote falls back to
 *     `concat('part', "'", 'part')`. XPath 1.0 has no string-escape
 *     syntax, so the alternating-quote concat is the portable form
 *     the grammar at
 *     `lib/commcare/xpath/grammar.lezer.grammar:128-131` admits.
 *     The fallback always emits boundary segments even when empty
 *     (e.g. a value of `"'"` produces `concat('', "'", '')`) so the
 *     segment count tracks the input quote count predictably.
 *   - In `csql`, `concat()` is not in the value-function whitelist
 *     (see file header), so the emitter switches to a double-quoted
 *     literal `"<value>"` when the value contains a single quote.
 *     If the value contains BOTH a single and a double quote, no
 *     portable inline escape exists — `concat()` is unavailable and
 *     XPath 1.0 string literals can carry only one of the two quote
 *     styles. The emitter throws rather than emit broken wire output;
 *     authors must split such values into a different filter shape
 *     or strip one of the quote types upstream.
 */
function emitStringLiteral(value: string, ctx: EmissionContext): string {
	const hasSingleQuote = value.includes("'");
	if (!hasSingleQuote) return `'${value}'`;
	if (ctx === "csql") {
		const hasDoubleQuote = value.includes('"');
		if (hasDoubleQuote) {
			throw new Error(
				`emitXPath: CSQL has no portable escape for a string literal containing both ' and ". Got: ${JSON.stringify(value)}.`,
			);
		}
		return `"${value}"`;
	}
	const parts = value.split("'");
	const args: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		args.push(`'${parts[i]}'`);
		if (i < parts.length - 1) args.push(`"'"`);
	}
	return `concat(${args.join(", ")})`;
}

/**
 * Compile a numeric literal to its wire form, avoiding scientific
 * notation. CommCare's XPath grammar admits decimal literals only —
 * `digit+ ('.' digit*)? | '.' digit+` per
 * `lib/commcare/xpath/grammar.lezer.grammar:133-136` — and rejects
 * exponent syntax. JavaScript's `String(n)` switches to exponent
 * form for very small magnitudes (below ~1e-6) and very large ones
 * (at or above 1e21), which would parse-fail downstream.
 *
 * The function early-returns the canonical `String(n)` for any
 * number whose decimal form is already non-exponent. That preserves
 * the shortest round-trip form (e.g. `String(3.14)` is the literal
 * `"3.14"`, not the `toFixed(20)` artifact
 * `"3.14000000000000012434"`) for every value an author would
 * realistically type. Only when `String(n)` produces exponent form
 * does the function reformat by parsing the mantissa and exponent
 * out of the string and shifting the decimal point manually,
 * producing an exact decimal expansion of the IEEE-754 double's
 * `String(n)` form without `toFixed`'s precision-related truncation
 * at the limits.
 *
 * The schema layer (`z.number()` in `lib/domain/predicate/types.ts`)
 * rejects `NaN` and `±Infinity`, so this helper is only ever called
 * with finite numbers.
 */
function emitNumericLiteral(n: number): string {
	const s = String(n);
	if (!s.includes("e") && !s.includes("E")) return s;
	// `String(n)` for any finite double in exponent form matches
	// `^(-)?<int>(\.<frac>)?[eE][+-]?<exp>$`. Parse the components
	// and rebuild as a non-exponent decimal by sliding the decimal
	// point `exp` places. The combined `<int><frac>` digit sequence
	// is the significand; the decimal point lands at position
	// `int.length + exp` in that sequence, with leading or trailing
	// zeros padded as needed.
	const match = s.match(/^(-)?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
	if (!match) return s;
	const sign = match[1] ?? "";
	const intPart = match[2];
	const fracPart = match[3] ?? "";
	const exp = Number.parseInt(match[4], 10);
	const digits = intPart + fracPart;
	const decimalPos = intPart.length + exp;
	if (decimalPos >= digits.length) {
		return `${sign}${digits}${"0".repeat(decimalPos - digits.length)}`;
	}
	if (decimalPos > 0) {
		return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
	}
	return `${sign}0.${"0".repeat(-decimalPos)}${digits}`;
}
