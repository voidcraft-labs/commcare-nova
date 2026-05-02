// lib/commcare/predicate/xpathEmitter.ts
//
// Transitional single-context predicate emitter superseded by the
// per-dialect emitters in this directory. Lexical concerns (string-
// literal escape, identifier emission, numeric formatting) live in
// `./stringQuoting`; this file's `EmissionContext` is a structural
// subset of `WireDialect`. CCHQ wire-form citations for the operator
// arms below remain authoritative until the per-dialect operator
// emitters land.

import type {
	ComparisonKind,
	Predicate,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";

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
 *   - `corehq/ex-submodules/casexml/apps/case/xml/generator.py:237-246`
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

// Operand handling: predicate operators carry `ValueExpression`
// operands. This emitter accepts only the `term` arm and throws on
// every other arm; the exhaustive switch makes any new arm a
// compile-time error here.

function unwrapTermFromExpression(expr: ValueExpression): Term {
	switch (expr.kind) {
		case "term":
			return expr.term;
		case "today":
		case "now":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "unwrap-list":
		case "format-date":
			throw new Error(
				`xpathEmitter: arm '${expr.kind}' is not handled by this emitter; only the term-arm structural lifter is supported here.`,
			);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`xpathEmitter: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

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
			// Operands are `ValueExpression`; unwrap the term arm via
			// `unwrapTermFromExpression`. Non-term arms throw.
			return `${emitTerm(unwrapTermFromExpression(p.left), ctx)} ${COMPARISON_OPS[p.kind]} ${emitTerm(unwrapTermFromExpression(p.right), ctx)}`;
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
		case "in": {
			// Set-membership over a value list with value-equality
			// semantics: "the property's value equals one of these
			// literals". Single-value collapses to a plain equality
			// (`<prop> = '<v>'`) and multi-value expands to an
			// or-of-equalities (`(<prop> = '<v1>' or <prop> = '<v2>')`),
			// keeping the semantics structurally continuous from
			// one to many.
			//
			// CCHQ's `selected-any(prop, '<v1> <v2>')` looks like a
			// fit at first glance, but it carries multi-select-token
			// semantics: ES's `case_property_text_query` tokenizes
			// the value string by whitespace and matches ANY token
			// (verified at
			// `corehq/apps/es/case_search.py:291-296` — the docstring
			// states "If the value has multiple words, they will be
			// OR'd together in this query"). That silently breaks
			// `isIn` as soon as any value contains a space:
			// `isIn(name, "Alice Smith")` (one literal) and
			// `isIn(name, "Alice Smith", "Bob")` (a list of two)
			// would land on different result sets because the
			// multi-arg path would tokenize "Alice", "Smith", "Bob"
			// independently. Multi-select containment ("the
			// multi-select prop contains any of these tokens") is a
			// distinct concept that needs its own AST kind and
			// emitter; `isIn` is value-equality set membership.
			//
			// Both arms route the property reference through
			// `emitTerm` so the reserved-attribute prefix logic
			// (`@status` etc.) applies, and each value through
			// `emitLiteral` so the per-context string-escape
			// pipeline handles embedded quotes identically to
			// comparison operators. The multi-value emission wraps
			// the or-clause in parens defensively — XPath's `and`
			// binds tighter than `or`, so a parent `and` would
			// silently re-associate an unwrapped or-chain. Wrapping
			// always avoids any ambiguity at the cost of one
			// redundant pair when the predicate sits at the
			// outermost level.
			// `p.left` is `ValueExpression`; unwrap the term arm.
			const left = emitTerm(unwrapTermFromExpression(p.left), ctx);
			if (p.values.length === 1) {
				return `${left} = ${emitLiteral(p.values[0].value, ctx)}`;
			}
			const clauses = p.values
				.map((v) => `${left} = ${emitLiteral(v.value, ctx)}`)
				.join(" or ");
			return `(${clauses})`;
		}
		case "within-distance":
			// Geo radius filter. CCHQ's wire form is
			// `within-distance(prop, '<lat,lon>', <distance>, '<unit>')`
			// per `corehq/apps/case_search/xpath_functions/query_functions.py:54-81`.
			// The distance argument is a bare XPath numeric literal
			// (not a quoted string) — `GeoPoint.from_string` parses
			// the coords, then `float(distance)` parses the numeric
			// argument. Distances therefore route through
			// `emitNumericLiteral` to dodge the scientific-notation
			// form that CommCare's XPath grammar rejects (see the
			// `emitNumericLiteral` JSDoc for the grammar citation).
			// The unit is a schema-validated enum
			// (`miles` | `kilometers`), so it interpolates directly
			// inside single quotes without an escape pass.
			//
			// `p.center` is `ValueExpression`; unwrap the term arm.
			// `p.property` is a `PropertyRef` and emits directly.
			return `within-distance(${emitTerm(p.property, ctx)}, ${emitTerm(unwrapTermFromExpression(p.center), ctx)}, ${emitNumericLiteral(p.distance)}, '${p.unit}')`;
		case "match":
		case "multi-select-contains":
			// `match` and `multi-select-contains` carry per-mode /
			// per-quantifier dispatches whose wire form differs across
			// dialects. Per-mode dispatch for `match`:
			//
			//   - `starts-with` is emittable in case-list-filter
			//     (`starts-with(prop, 'v')`); the other three modes
			//     (`fuzzy`, `phonetic`, `fuzzy-date`) are CSQL-only —
			//     verified at
			//     `commcare-core/.../parser/ast/ASTNodeFunctionCall.java:113-268`,
			//     where the on-device dispatcher registers no handler
			//     for `fuzzy-match` / `phonetic-match` / `fuzzy-date`.
			//     CSQL emits each mode via its named wire function
			//     (`fuzzy-match` / `phonetic-match` / `fuzzy-date` /
			//     `starts-with` per
			//     `commcare-hq/.../xpath_functions/__init__.py:39-54`).
			//
			// Per-quantifier dispatch for `multi-select-contains`:
			//
			//   - `any` single-value is `selected(prop, 'v')` in both
			//     contexts; `any` multi-value expands to OR-of-
			//     `selected()` on-device but emits as one
			//     `selected-any(prop, 'v1 v2')` call in CSQL;
			//     `all` expands to AND-of-`selected()` on-device and to
			//     `selected-all(prop, 'v1 v2')` in CSQL.
			//
			// The dialect-specific dispatch lives in the per-dialect
			// emitter modules; the throws here defend the exhaustiveness
			// surface — silently accepting either kind would emit a
			// wrong-dialect string.
			throw new Error(`emitPredicate: no emission for kind '${p.kind}'`);
		case "when-input-present": {
			// Conditional-include wrapper. The wrapped clause runs
			// only if the named search input is present at runtime;
			// otherwise the wrapper is a no-op.
			//
			// CSQL has no native conditional construct: `if` and
			// `count` are absent from both `XPATH_VALUE_FUNCTIONS`
			// (8 functions, lines 27-36) and `XPATH_QUERY_FUNCTIONS`
			// (14 functions, lines 39-54) at
			// `corehq/apps/case_search/xpath_functions/__init__.py:27-54`.
			// CCHQ's canonical conditional pattern at
			// `docs/case_search_query_language.rst:299-303` handles
			// the conditionality OUTSIDE the CSQL string — an XPath
			// `if(count(<input>), <CSQL-string-A>, <CSQL-string-B>)`
			// chooses between two pre-built CSQL strings, neither
			// of which contains `if` or `count` itself. The CSQL
			// emitter therefore cannot encode `when-input-present`
			// at this layer; the wire-wrapping layer that builds
			// the outer XPath must emit two distinct CSQL strings
			// (one with the input substituted, one without) and
			// select between them at runtime.
			if (ctx === "csql") {
				throw new Error(
					"emitXPath: when-input-present cannot be emitted directly in csql context. " +
						"The wire-wrapping layer must handle conditionality by emitting separate " +
						"CSQL strings for input-set and input-unset states.",
				);
			}
			// case-list-filter: the predicate drops directly into a
			// casedb XPath nodeset (`instance('casedb')/casedb/case[<this>]`),
			// where CommCare's XPath dialect supports `if` and
			// `count`. The fallback is `true()` (not `''`): XPath's
			// boolean coercion of `''` is `false`, which would
			// silently exclude every case on input-unset. `true()`
			// is the no-op identity for AND-chained clauses, so
			// AND-combining the wrapper with sibling clauses leaves
			// them unchanged when the trigger input is unset and
			// applies the wrapped clause when it is set. The inner
			// clause recurses with `parentPrec: 0` because the
			// function-call argument position is its own grouping
			// boundary, so no outer parens wrap a logical-operator
			// inner.
			const inputExpr = emitTerm(p.input, ctx);
			const thenExpr = emitPredicate(p.clause, ctx, 0);
			return `if(count(${inputExpr}), ${thenExpr}, true())`;
		}
		case "is-blank":
			// Portable absent-or-empty: `<term> = ''` covers both
			// states on every CCHQ dialect. `p.left` is
			// `ValueExpression`; unwrap the term arm.
			return `${emitTerm(unwrapTermFromExpression(p.left), ctx)} = ''`;
		case "is-null":
			// There is no CCHQ wire form for strict-absent semantics;
			// the emitter throws as a defensive backstop if the
			// representability check is bypassed.
			throw new Error(
				`emitPredicate: 'is-null' is unrepresentable on CCHQ wire targets`,
			);
		case "match-all":
		case "match-none":
		case "between":
		case "exists":
		case "missing":
			// This single-context emitter has no emission rules for
			// these operators. Throwing keeps the function's type-
			// system exhaustiveness surface sound — silent fall-through
			// would emit `undefined` and corrupt downstream string
			// concatenation.
			throw new Error(`emitPredicate: no emission for kind '${p.kind}'`);
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
				return `@${quoteIdentifier(term.property)}`;
			}
			return quoteIdentifier(term.property);
		}
		case "input":
			return `instance('search-input:results')/input/field[@name='${term.name}']`;
		case "session-user":
			// Open-namespace custom user-data field. The wire path is
			// `instance('commcaresession')/session/user/data/<field>`;
			// `<field>` is interpolated directly because `field` is
			// already constrained at the schema layer to XML element-name
			// vocabulary (no quoting / escaping is required for valid
			// values, and invalid values reject at parse time before they
			// reach this emitter).
			return `instance('commcaresession')/session/user/data/${term.field}`;
		case "session-context":
			// Closed-namespace framework-controlled context field. The
			// wire path is
			// `instance('commcaresession')/session/context/<field>`;
			// `<field>` is one of the four `SESSION_CONTEXT_FIELDS`
			// members (verified at the schema layer), so direct
			// interpolation is safe.
			return `instance('commcaresession')/session/context/${term.field}`;
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

function emitStringLiteral(value: string, ctx: EmissionContext): string {
	// `EmissionContext` is a structural subset of `WireDialect`; the
	// helper accepts the wider union and honors the same per-dialect
	// branching for the two contexts this transitional emitter knows.
	return quoteLiteral(value, ctx);
}

function emitNumericLiteral(n: number): string {
	return formatNumeric(n);
}
