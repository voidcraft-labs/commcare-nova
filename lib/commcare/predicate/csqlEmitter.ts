// lib/commcare/predicate/csqlEmitter.ts
//
// Per-dialect emitter producing the on-device XPath wrapper that builds
// a CSQL `_xpath_query` string at runtime. CSQL is the server-side
// dialect evaluated by ElasticSearch on the CCHQ server when a
// case-search remote-request fires; the wire form is documented at
// `commcare-hq/docs/case_search_query_language.rst`. Two CSQL function
// whitelists at
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-54`
// constrain what the inner CSQL fragment may contain.
//
// The emitter runs a three-stage pipeline:
//
//   1. Hoist non-grammar value expressions (`if` / `switch` /
//      `arith` / `concat` / `coalesce` / `format-date` /
//      non-comparison-LHS `count`) out of the predicate AST via
//      `csqlHoist.ts`. The lifted expressions become wrapper
//      expressions that the wire layer threads into the enclosing
//      form's `<data>` section. The hoist pass is total — every input
//      AST produces a faithful CSQL emission via grammar shapes plus
//      on-device wrappers.
//   2. Walk the hoisted AST emitting a `CsqlSegment[]` IR — each
//      segment is either a constant CSQL fragment or a runtime XPath
//      expression that produces a string interpolated into the CSQL
//      fragment at runtime. The segment list, not a re-parse of an
//      emitted string, is the source for the concat-wrapping pass.
//   3. Map the segment list into a `concat(...)` XPath expression — the
//      canonical CCHQ pattern at
//      `commcare-hq/docs/case_search_query_language.rst:403-407`. Every
//      CSQL value is wrapped in `concat(...)`, even predicates with no
//      runtime interpolation, so the downstream wire layer reads one
//      uniform shape.
//
// `mergeAdjacentConstants` runs once at the wrap layer; per-arm
// emitters produce raw segment lists without internal merging. This
// keeps the per-arm code straight-line and the merge logic
// centralised at the top-level wrap.
//
// CSQL value strings interpolating runtime refs use double-quoted
// CSQL string literals (`= "<value>"`) so the surrounding XPath
// `concat(...)` arguments can use single-quoted XPath string literals
// without an embedded-quote conflict — the canonical CCHQ pattern at
// `case_search_query_language.rst:403-407`. Constant-only string
// emissions route through `quoteLiteral(value, "csql")` from
// `stringQuoting.ts`, which uses single-quoted CSQL by default and
// switches to double-quoted CSQL when the value contains a single
// quote. The two strategies coexist because the runtime-interpolation
// arm has no compile-time knowledge of the user's typed value, so the
// wire form must commit to one quote style at emit time and the
// double-quoted form is the one CCHQ's documented examples use.

import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationStep,
	SearchInputRef,
	SessionContextRef,
	SessionUserRef,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { type HoistedWrapper, hoistForCsql } from "./csqlHoist";
import { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";

/**
 * Output of the CSQL emission pipeline. The wire layer consumes both
 * fields:
 *
 *   - `wrapper` is the on-device XPath expression that builds the CSQL
 *     `_xpath_query` string at runtime. It is always a `concat(...)`
 *     call regardless of whether any segments interpolate a runtime
 *     value, so the wire layer can drop it into a `<data
 *     key="_xpath_query" ref="...">` slot uniformly.
 *   - `hoists` is the wrapper-expression list returned from the hoist
 *     pass — each entry binds a synthetic search-input name to the
 *     ValueExpression that builds its runtime value. The wire layer
 *     emits one `<data>` element per wrapper before the CSQL data
 *     element so the wrapper inputs resolve before the CSQL fragment
 *     does.
 */
export interface CsqlEmissionResult {
	readonly wrapper: string;
	readonly hoists: readonly HoistedWrapper[];
}

/**
 * Internal IR between the AST walker and the concat-wrapping pass.
 * Each segment is either a constant CSQL fragment or a runtime XPath
 * expression whose result is interpolated as a string into the final
 * CSQL value at evaluation time.
 *
 * The two-arm shape lets the wrapping pass emit each segment as a
 * separate `concat(...)` argument without parsing the emitted CSQL
 * string back out, which would otherwise be ambiguous given that
 * runtime-resolved instance paths contain single quotes and the CSQL
 * string itself uses single and double quotes interchangeably.
 */
type CsqlSegment =
	| { readonly kind: "constant"; readonly text: string }
	| { readonly kind: "runtime"; readonly xpath: string };

/**
 * Comparison-operator AST kind → CSQL wire token. CSQL inherits the
 * six XPath-1.0 binary comparison operators (`=`, `!=`, `<`, `<=`,
 * `>`, `>=`); the parser dispatches them at
 * `commcare-hq/corehq/apps/case_search/filter_dsl.py:88-90` via
 * `property_comparison_query`, drawing the comparator set from
 * `commcare-hq/corehq/apps/case_search/const.py:124-132`
 * (`COMPARISON_OPERATORS = [EQ, NEQ] + list(RANGE_OP_MAPPING.keys())`).
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
 * The four CommCare case properties CSQL recognises as system metadata
 * with the `@`-prefix. Sourced from
 * `commcare-hq/corehq/apps/case_search/const.py:53-103` — the
 * `INDEXED_METADATA_BY_KEY` registration carrier where the four keys
 * below carry an explicit `@`-prefix while the other six system
 * metadata keys do not. The on-device dialect uses the same set
 * because CCHQ stores them as XML attributes on `<case>` per
 * `commcare-hq/corehq/ex-submodules/casexml/apps/case/xml/generator.py:237-246`.
 */
const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

/**
 * Operator-precedence levels for paren-grouping decisions. Higher
 * values bind tighter. The recursive walker passes its own level down
 * as `parentPrec`; a child whose level is lower than `parentPrec`
 * wraps itself in parens to preserve authored grouping. Comparison
 * leaves carry no slot here because their operands are terms, not
 * predicates.
 */
const PREC_OR = 1;
const PREC_AND = 2;

/**
 * Top-level entry point. Hoists, emits, wraps in `concat(...)`,
 * returns both the wrapper string and the hoisted-wrapper list. The
 * hoist pass is total — every input AST produces a faithful CSQL
 * emission via grammar shapes plus on-device wrappers.
 *
 * `emitCsql` is the public entry that runs the hoist pass first;
 * internal callers that already hold a hoisted AST (e.g. the
 * `when-input-present` recursive emitter) call `emitHoistedCsql`
 * directly to skip the redundant scan.
 */
export function emitCsql(predicate: Predicate): CsqlEmissionResult {
	const hoistResult = hoistForCsql(predicate);
	return {
		wrapper: emitHoistedWrapper(hoistResult.hoisted),
		hoists: hoistResult.wrappers,
	};
}

/**
 * Internal entry that takes a pre-hoisted predicate and produces the
 * `concat(...)` wrapper string. Used by the recursive emitter for
 * `when-input-present` (where the inner clause is already hoisted as
 * part of the outer hoist walk).
 */
function emitHoistedWrapper(predicate: Predicate): string {
	const segments = emitPredicateSegments(predicate, 0);
	return wrapInConcat(segments);
}

/**
 * Wrap a segment list in a `concat(...)` XPath expression. The wrap
 * is unconditional: even a predicate with no runtime interpolation
 * produces `concat('<full csql>')` so the wire layer reads one
 * uniform shape per `_xpath_query` value.
 *
 * The wrap layer is the single merge point for adjacent constant
 * segments; per-arm emitters produce raw segment lists without
 * internal merging. After merging, each constant segment lifts via
 * `quoteConstantSegmentForXPath`, which can produce one or more
 * comma-separated XPath args depending on whether the constant
 * contains both `'` and `"` — XPath 1.0 has no string-escape syntax
 * and the wrap is itself a `concat(...)` argument list, so a
 * both-quotes constant splits into a sequence of single- or
 * double-quoted runs joined by `"'"` separators (the `concat()`
 * alternating-quote idiom). Runtime segments pass through verbatim
 * as their own concat args.
 */
function wrapInConcat(segments: readonly CsqlSegment[]): string {
	const merged = mergeAdjacentConstants(segments);
	const args: string[] = [];
	for (const seg of merged) {
		if (seg.kind === "runtime") {
			args.push(seg.xpath);
			continue;
		}
		args.push(...quoteConstantSegmentForXPath(seg.text));
	}
	return `concat(${args.join(", ")})`;
}

/**
 * Compile a constant CSQL fragment to a sequence of one or more XPath
 * string literals. XPath 1.0 string literals admit either `'` or `"`
 * as the bracketing character but never both within one literal — see
 * the grammar at `lib/commcare/xpath/grammar.lezer.grammar:128-131`.
 * The wrap layer must emit each constant's content faithfully; when
 * the content contains both quote styles, we split it into sub-runs
 * of "no embedded `'`" (wrap in `'...'`) and "embedded `'` only" (wrap
 * in `"..."`) and concatenate via additional `concat(...)` arguments.
 *
 * The split rule:
 *
 *   - No `'` in the value → single-quoted XPath literal. The common
 *     case.
 *   - No `"` in the value → double-quoted XPath literal.
 *   - Both quote styles present → split on `'`. Each fragment becomes
 *     a single-quoted literal `'<frag>'`; between fragments, emit
 *     `"'"` (the literal-quote separator). Boundary fragments that
 *     are empty still emit so the output's segment count tracks the
 *     input's quote count predictably.
 *
 * The both-styles split path mirrors `stringQuoting.ts`'s
 * case-list-filter alternating-quote idiom — the pattern is XPath
 * 1.0's only portable form for embedding a `'` in a string literal,
 * documented at `lib/commcare/xpath/grammar.lezer.grammar:128-131`
 * and the canonical XPath 1.0 specification.
 */
function quoteConstantSegmentForXPath(value: string): string[] {
	const hasSingleQuote = value.includes("'");
	const hasDoubleQuote = value.includes('"');
	if (!hasSingleQuote) return [`'${value}'`];
	if (!hasDoubleQuote) return [`"${value}"`];
	// Both quote styles. Split the value on `'` and emit alternating
	// single-quoted runs and `"'"` separators, matching XPath's
	// concat-of-alternating-quotes idiom.
	const parts = value.split("'");
	const args: string[] = [];
	for (let i = 0; i < parts.length; i += 1) {
		args.push(`'${parts[i]}'`);
		if (i < parts.length - 1) args.push(`"'"`);
	}
	return args;
}

/**
 * Recursive walker producing segment-list output for a predicate. The
 * emitter routes per-arm dispatch through this function; child
 * predicates recurse with the appropriate precedence so paren-grouping
 * preserves authored structure.
 *
 * Each arm appends to a `CsqlSegment[]` accumulator. Logical operators
 * concatenate child segment lists with constant separator tokens
 * (` and ` / ` or `); leaf operators emit either a single constant
 * segment (when no runtime ref appears) or three segments around an
 * interpolated runtime ref (when a value-position term resolves at
 * runtime). The wrap layer collapses adjacent constant segments — per-
 * arm code does not pre-merge.
 */
function emitPredicateSegments(
	p: Predicate,
	parentPrec: number,
): CsqlSegment[] {
	switch (p.kind) {
		case "match-all":
			// CCHQ's zero-arg query function at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:52`.
			return [{ kind: "constant", text: "match-all()" }];
		case "match-none":
			// CCHQ's zero-arg query function at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:53`.
			return [{ kind: "constant", text: "match-none()" }];
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return emitComparisonSegments(p);
		case "and":
			return emitLogicalSegments(p.clauses, " and ", PREC_AND, parentPrec);
		case "or":
			return emitLogicalSegments(p.clauses, " or ", PREC_OR, parentPrec);
		case "not": {
			// `not(...)` is in CCHQ's query-function whitelist at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:40`.
			// The parens around the inner are the function-call argument
			// list; the inner recurses with `parentPrec: 0` so no outer
			// paren wraps a logical-operator inner.
			const inner = emitPredicateSegments(p.clause, 0);
			return [
				{ kind: "constant", text: "not(" },
				...inner,
				{ kind: "constant", text: ")" },
			];
		}
		case "in":
			return emitInSegments(p);
		case "between":
			return emitBetweenSegments(p);
		case "is-blank":
		case "is-null":
			// Both emit as `<term> = ''` on CSQL — the server-side
			// `case_property_query()` short-circuits to
			// `case_property_missing()` semantics at
			// `commcare-hq/corehq/apps/es/case_search.py:241-246`,
			// matching absent / cleared / empty alike. The strict-
			// absent intent of `is-null` is faithfully expressed as the
			// closest CSQL form (the same wire that `is-blank` uses);
			// runtime-strict semantics live on the Postgres target and
			// don't surface on CCHQ's wire dialect.
			return emitAbsenceSegments(p);
		case "match":
			return emitMatchSegments(p);
		case "multi-select-contains":
			return emitMultiSelectSegments(p);
		case "within-distance":
			return emitWithinDistanceSegments(p);
		case "exists":
			return emitExistsSegments(p, "exists");
		case "missing":
			return emitExistsSegments(p, "missing");
		case "when-input-present":
			return emitWhenInputPresentSegments(p);
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`csqlEmitter: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Emit `when-input-present(trigger, clause)` as the canonical CCHQ
 * pattern at
 * `commcare-hq/docs/case_search_query_language.rst:299-303`:
 *
 *   `if(count(<trigger-xpath>), <inner-csql>, 'match-all()')`
 *
 * Where `<inner-csql>` is the CSQL emission of the inner clause as a
 * complete `concat(...)` XPath expression. When the trigger input is
 * unset, `count(<trigger-xpath>)` is 0 and the wrapper returns
 * `'match-all()'` (the AND-identity in CSQL — combined with sibling
 * AND-clauses, it is a no-op). When the trigger is set, the wrapper
 * returns the inner clause's CSQL fragment, which the server
 * evaluates against the case data.
 *
 * The inner clause is already hoisted by the outer `hoistForCsql`
 * call (which walked into `p.clause`), so this emitter calls
 * `emitHoistedWrapper` directly rather than re-running
 * `hoistForCsql`. The inner clause's hoists already live on the
 * outer wrapper list; the inner emission produces only the
 * `concat(...)` XPath expression.
 *
 * The `if(...)` wrapper expression flows out as a single runtime
 * segment in the outer concat, exactly the shape used elsewhere for
 * search-input refs.
 */
function emitWhenInputPresentSegments(
	p: Extract<Predicate, { kind: "when-input-present" }>,
): CsqlSegment[] {
	const triggerXPath = emitSearchInputXPath(p.input);
	const innerWrapper = emitHoistedWrapper(p.clause);
	const conditionalXPath = `if(count(${triggerXPath}), ${innerWrapper}, 'match-all()')`;
	return [{ kind: "runtime", xpath: conditionalXPath }];
}

/**
 * Emit a comparison predicate. Operands flow through
 * `emitComparisonOperandSegments`, which yields a `CsqlSegment[]` for
 * either side — terms produce a single segment, while
 * `subcase-count(...)` operands produce a multi-segment list when
 * the filter argument carries runtime refs (composing into the outer
 * concat the same way the rest of the emission does).
 */
function emitComparisonSegments(
	p: Extract<Predicate, { kind: ComparisonKind }>,
): CsqlSegment[] {
	const leftSegs = emitComparisonOperandSegments(p.left);
	const rightSegs = emitComparisonOperandSegments(p.right);
	const op = COMPARISON_OPS[p.kind];
	return joinComparisonSegmentLists(leftSegs, op, rightSegs);
}

/**
 * Compile a comparison operand to a segment list. Three operand
 * shapes can reach this slot after the hoist pass:
 *
 *   - `term`-arm ValueExpression (the common case): unwrap, emit via
 *     `emitTermSegment`, wrap runtime refs in CSQL double-quoted
 *     brackets.
 *   - `count(subcasePath, ...)` (CCHQ's recognised `subcase-count`
 *     form per `_is_subcase_count` at
 *     `commcare-hq/corehq/apps/case_search/filter_dsl.py:80-86`):
 *     emit as `subcase-count('<id>', <filter>)`. The filter
 *     argument's segments splice inline so any runtime refs
 *     compose into the outer concat.
 *   - `date-coerce` / `datetime-coerce`: emit as the CSQL value
 *     functions `date(...)` / `datetime(...)` (the AST kind name
 *     diverges from the wire function name).
 */
function emitComparisonOperandSegments(expr: ValueExpression): CsqlSegment[] {
	if (expr.kind === "count") {
		if (expr.via.kind !== "subcase") {
			throw new Error(
				`csqlEmitter: count with via.kind === '${expr.via.kind}' reached the comparison-LHS emitter; the hoist pass should have lifted it`,
			);
		}
		const identifierLiteral = quoteLiteral(expr.via.identifier, "csql");
		if (expr.where === undefined) {
			return [
				{ kind: "constant", text: `subcase-count(${identifierLiteral})` },
			];
		}
		const filterSegments = emitFilterArgumentSegments(expr.where);
		return [
			{ kind: "constant", text: `subcase-count(${identifierLiteral}, ` },
			...filterSegments,
			{ kind: "constant", text: ")" },
		];
	}
	if (expr.kind === "date-coerce" || expr.kind === "datetime-coerce") {
		return emitCoerceCallSegments(expr);
	}
	const term = emitTermSegment(unwrapTermFromExpression(expr));
	return wrapTermAsSegmentList(term);
}

/**
 * Wrap a single `TermEmission` into a `CsqlSegment[]`. Constant
 * emissions become a single constant segment; runtime emissions wrap
 * in CSQL double-quoted brackets so the runtime XPath result
 * interpolates as a CSQL string value (the canonical pattern at
 * `commcare-hq/docs/case_search_query_language.rst:403-407`).
 *
 * Centralising the wrap shape here keeps every operand emission path
 * — comparison operands, `in` values, `between` bounds — consistent
 * on the runtime-bracketing rule.
 */
function wrapTermAsSegmentList(term: TermEmission): CsqlSegment[] {
	if (term.kind === "constant") {
		return [{ kind: "constant", text: term.text }];
	}
	return [
		{ kind: "constant", text: '"' },
		{ kind: "runtime", xpath: term.xpath },
		{ kind: "constant", text: '"' },
	];
}

/**
 * Emit a `date-coerce` or `datetime-coerce` ValueExpression as its
 * CSQL value-function form. The AST kind names diverge from the wire
 * function names: AST `date-coerce(value)` becomes wire `date(value)`
 * (registered at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:28`);
 * AST `datetime-coerce(value)` becomes wire `datetime(value)`
 * (registered at line 30).
 *
 * The argument flows through the term emitter; runtime refs
 * interpolate inside the function-call parens unwrapped (CSQL
 * function-call argument position accepts a runtime XPath result
 * directly without surrounding string-quote brackets, since the
 * function consumes a value, not a quoted string literal).
 */
function emitCoerceCallSegments(
	expr: Extract<ValueExpression, { kind: "date-coerce" | "datetime-coerce" }>,
): CsqlSegment[] {
	const fnName = expr.kind === "date-coerce" ? "date" : "datetime";
	const inner = emitTermSegment(unwrapTermFromExpression(expr.value));
	if (inner.kind === "constant") {
		return [{ kind: "constant", text: `${fnName}(${inner.text})` }];
	}
	return [
		{ kind: "constant", text: `${fnName}(` },
		{ kind: "runtime", xpath: inner.xpath },
		{ kind: "constant", text: ")" },
	];
}

/**
 * Join two operand segment lists around a comparison operator. The
 * operator constant goes between them; the wrap-layer
 * `mergeAdjacentConstants` pass collapses constant runs.
 *
 * The operands' segment lists already include any CSQL-string-quote
 * wrapping needed for runtime interpolation — the comparison-operand
 * emitter wraps each runtime ref in `"<runtime>"` (double-quoted CSQL
 * bracket per the canonical CCHQ pattern at
 * `commcare-hq/docs/case_search_query_language.rst:403-407`), so the
 * join doesn't add or remove quoting.
 */
function joinComparisonSegmentLists(
	left: readonly CsqlSegment[],
	op: string,
	right: readonly CsqlSegment[],
): CsqlSegment[] {
	return [...left, { kind: "constant", text: ` ${op} ` }, ...right];
}

/**
 * Single-segment-operand variant of `joinComparisonSegmentLists`,
 * used by `in` and `between` whose value lists are always single-
 * segment terms or literals on either side. Each operand routes
 * through `wrapTermAsSegmentList` so the runtime-bracketing shape
 * matches the comparison emission's runtime-interpolation rule.
 */
function joinComparisonSegments(
	left: TermEmission,
	op: string,
	right: TermEmission,
): CsqlSegment[] {
	return joinComparisonSegmentLists(
		wrapTermAsSegmentList(left),
		op,
		wrapTermAsSegmentList(right),
	);
}

/**
 * Emit a logical operator (`and` / `or`). Joins child segment lists
 * with the appropriate constant separator. Wraps the whole sequence
 * in parens when the parent precedence binds tighter than this
 * operator's level — XPath's `and` binds tighter than `or`, so
 * `(A or B) and C` must keep the parens around the `or`.
 */
function emitLogicalSegments(
	clauses: readonly Predicate[],
	separator: string,
	prec: number,
	parentPrec: number,
): CsqlSegment[] {
	const parts: CsqlSegment[] = [];
	for (let i = 0; i < clauses.length; i += 1) {
		if (i > 0) parts.push({ kind: "constant", text: separator });
		parts.push(...emitPredicateSegments(clauses[i] as Predicate, prec));
	}
	if (parentPrec > prec) {
		return [
			{ kind: "constant", text: "(" },
			...parts,
			{ kind: "constant", text: ")" },
		];
	}
	return parts;
}

/**
 * Emit an `in` membership predicate. Single-value collapses to a
 * plain equality; multi-value expands to an OR-of-equalities wrapped
 * in parens. The expansion is a deliberate design choice over CCHQ's
 * `selected-any` because `selected-any` tokenizes its value argument
 * by whitespace via ElasticSearch's `match`-query analyzer, which
 * `case_property_text_query` at
 * `commcare-hq/corehq/apps/es/case_search.py:291-302` forwards to;
 * `selected-any` would silently break `in` semantics on multi-word
 * values.
 */
function emitInSegments(p: Extract<Predicate, { kind: "in" }>): CsqlSegment[] {
	const left = emitTermSegment(unwrapTermFromExpression(p.left));
	if (p.values.length === 1) {
		const right = emitLiteralSegment(p.values[0].value);
		return joinComparisonSegments(left, "=", right);
	}
	// Multi-value — wrap the OR-of-equalities in parens defensively so a
	// parent `and` cannot re-associate the chain.
	const parts: CsqlSegment[] = [{ kind: "constant", text: "(" }];
	for (let i = 0; i < p.values.length; i += 1) {
		if (i > 0) parts.push({ kind: "constant", text: " or " });
		const right = emitLiteralSegment(p.values[i].value);
		parts.push(...joinComparisonSegments(left, "=", right));
	}
	parts.push({ kind: "constant", text: ")" });
	return parts;
}

/**
 * Emit a `between` predicate by expanding into the conjunction of two
 * boundary comparisons. CSQL recognises the six binary comparison
 * operators per
 * `commcare-hq/corehq/apps/case_search/const.py:124-132`; expanding
 * `between` keeps the wire form within that vocabulary.
 *
 * The `lowerInclusive` / `upperInclusive` flags pick the per-bound
 * operator (`>=` / `>` for the lower, `<=` / `<` for the upper). When
 * only one bound is present, the predicate degenerates to a single
 * comparison without the conjunction wrap.
 */
function emitBetweenSegments(
	p: Extract<Predicate, { kind: "between" }>,
): CsqlSegment[] {
	const left = emitTermSegment(unwrapTermFromExpression(p.left));
	const lowerOp = p.lowerInclusive ? ">=" : ">";
	const upperOp = p.upperInclusive ? "<=" : "<";
	const lowerSeg =
		p.lower !== undefined
			? emitTermSegment(unwrapTermFromExpression(p.lower))
			: undefined;
	const upperSeg =
		p.upper !== undefined
			? emitTermSegment(unwrapTermFromExpression(p.upper))
			: undefined;
	if (lowerSeg !== undefined && upperSeg !== undefined) {
		// Wrap the conjunction in parens unconditionally so a parent
		// `or` cannot re-associate the chain. Wrapping at every
		// `between` emission costs one redundant pair when the predicate
		// sits at the outermost level; that's the same trade-off the
		// `in` multi-value branch makes.
		const lowerPart = joinComparisonSegments(left, lowerOp, lowerSeg);
		const upperPart = joinComparisonSegments(left, upperOp, upperSeg);
		return [
			{ kind: "constant", text: "(" },
			...lowerPart,
			{ kind: "constant", text: " and " },
			...upperPart,
			{ kind: "constant", text: ")" },
		];
	}
	if (lowerSeg !== undefined) {
		return joinComparisonSegments(left, lowerOp, lowerSeg);
	}
	if (upperSeg !== undefined) {
		return joinComparisonSegments(left, upperOp, upperSeg);
	}
	// Schema's `.refine()` rejects the both-bounds-absent shape;
	// keep the branch defensive in case a pre-validated AST reaches
	// this emitter with both bounds stripped.
	throw new Error("csqlEmitter: 'between' has no bounds");
}

/**
 * Emit `is-blank` / `is-null` as `<term> = ''`. CCHQ's server-side
 * `case_property_query()` at
 * `commcare-hq/corehq/apps/es/case_search.py:241-246` short-circuits
 * `value == ''` to `case_property_missing()` semantics, matching
 * absent / cleared / empty alike on every CSQL emission. The two
 * predicate kinds map to the same wire form because CSQL has no
 * mechanism for distinguishing strict-absent from cleared from empty
 * — `is-null`'s strict-absent semantic surfaces only on the Postgres
 * target where JSONB key presence is observable.
 */
function emitAbsenceSegments(
	p: Extract<Predicate, { kind: "is-blank" | "is-null" }>,
): CsqlSegment[] {
	const left = emitTermSegment(unwrapTermFromExpression(p.left));
	if (left.kind === "constant") {
		return [{ kind: "constant", text: `${left.text} = ''` }];
	}
	// Runtime-resolved LHS — keep the equality shape but interpolate
	// the runtime ref into the LHS position.
	return [
		{ kind: "constant", text: '"' },
		{ kind: "runtime", xpath: left.xpath },
		{ kind: "constant", text: `" = ''` },
	];
}

/**
 * Emit a `match` predicate. Each mode maps to a CCHQ query function
 * registered at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`:
 *
 *   - `fuzzy` → `fuzzy-match` (line 48; ES `queries.fuzzy` against
 *     `PROPERTY_VALUE`).
 *   - `phonetic` → `phonetic-match` (line 49; Soundex via
 *     `sounds_like_text_query` at `query_functions.py:84-89`).
 *   - `fuzzy-date` → `fuzzy-date` (line 47; digit-permutation
 *     date match at `query_functions.py:101-113`).
 *   - `starts-with` → `starts-with` (line 50;
 *     `case_property_starts_with` at `query_functions.py:31-35`).
 *
 * `value` is a plain string — the schema rejects empty values per
 * `matchSchema`'s `.min(1)` rule. The property reference flows through
 * `emitTermSegment` so the reserved-attribute prefix logic applies.
 */
function emitMatchSegments(
	p: Extract<Predicate, { kind: "match" }>,
): CsqlSegment[] {
	const wireFunction = matchModeToWireFunction(p.mode);
	// `emitPropertyRefSegment` returns a `ConstantTermEmission` (the
	// narrowed `kind: "constant"` arm of `TermEmission`) — a property
	// reference is always a compile-time-known identifier. The match
	// emitter consumes that constancy directly: one constant CSQL
	// segment carries the entire `<fn>(<prop>, '<value>')` call.
	const propEmission = emitPropertyRefSegment(p.property);
	const valueLiteral = quoteLiteral(p.value, "csql");
	return [
		{
			kind: "constant",
			text: `${wireFunction}(${propEmission.text}, ${valueLiteral})`,
		},
	];
}

function matchModeToWireFunction(
	mode: "fuzzy" | "phonetic" | "fuzzy-date" | "starts-with",
): string {
	switch (mode) {
		case "fuzzy":
			return "fuzzy-match";
		case "phonetic":
			return "phonetic-match";
		case "fuzzy-date":
			return "fuzzy-date";
		case "starts-with":
			return "starts-with";
		default: {
			const _exhaustive: never = mode;
			throw new Error(
				`csqlEmitter: unhandled match mode ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Emit a `multi-select-contains` predicate. The quantifier discriminator
 * picks between `selected` / `selected-any` / `selected-all`; the
 * single-value `any` shape collapses to bare `selected(prop, 'v')`
 * because CCHQ's whitelist registers `selected` as an alias for
 * `selected-any` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:43`
 * ("selected and selected_any function identically.").
 *
 * Multi-value `any` and any-arity `all` share the space-joined-token
 * shape — CCHQ's `case_property_text_query` at
 * `commcare-hq/corehq/apps/es/case_search.py:291-302` forwards the
 * value argument to ElasticSearch's `match` query, whose analyzer
 * tokenizes by whitespace and applies the per-quantifier `OR` /
 * `AND` operator.
 *
 * Each value flows through the literal emitter at the segment level;
 * the values join with a single space and the joined string flows
 * through `quoteLiteral` so per-value embedded quotes route through
 * the per-dialect escape. Null values lower to the wire-form empty
 * string (matching the AST schema's all-null rejection at
 * `multiSelectContainsSchema.refine`).
 */
function emitMultiSelectSegments(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
): CsqlSegment[] {
	const propText = emitPropertyRefText(p.property);
	const tokens = p.values.map((v) => stringifyLiteralValue(v.value));
	const joinedValue = tokens.join(" ");
	const fnName =
		p.values.length === 1 && p.quantifier === "any"
			? "selected"
			: p.quantifier === "any"
				? "selected-any"
				: "selected-all";
	const valueLiteral = quoteLiteral(joinedValue, "csql");
	return [
		{
			kind: "constant",
			text: `${fnName}(${propText}, ${valueLiteral})`,
		},
	];
}

/**
 * Compile a literal value to its CSQL wire-form string used inside a
 * `selected*` value list. CCHQ's `selected*` family treats the value
 * argument as a string, so numeric and boolean literals coerce to
 * their CommCare-canonical string forms here. Null lowers to the
 * empty string (matching `selected`'s wire-side absent-or-empty
 * collapse).
 */
function stringifyLiteralValue(
	value: string | number | boolean | null,
): string {
	if (value === null) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return formatNumeric(value);
	return value;
}

/**
 * Emit a `within-distance` predicate. CCHQ's wire form is
 * `within-distance(property, '<lat lon>', distance, 'unit')` per
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:54-81`.
 * The function's signature: `confirm_args_count(node, 4)` →
 * (1) property name (string), (2) coordinate string parsed via
 * `GeoPoint.from_string`, (3) numeric distance (parsed via `float`),
 * (4) unit identifier validated against
 * `commcare-hq/corehq/apps/es/queries.py:22-23`'s `DISTANCE_UNITS`.
 *
 * The center coordinate is a ValueExpression slot — usually a
 * `literal("<lat,lon>")` term but possibly a search-input ref for
 * runtime user-typed coordinates. Runtime refs interpolate via the
 * standard segment shape; literal refs flow through `quoteLiteral`.
 */
function emitWithinDistanceSegments(
	p: Extract<Predicate, { kind: "within-distance" }>,
): CsqlSegment[] {
	const propText = emitPropertyRefText(p.property);
	const center = emitTermSegment(unwrapTermFromExpression(p.center));
	const distanceText = formatNumeric(p.distance);
	const unitText = quoteLiteral(p.unit, "csql");
	if (center.kind === "constant") {
		return [
			{
				kind: "constant",
				text: `within-distance(${propText}, ${center.text}, ${distanceText}, ${unitText})`,
			},
		];
	}
	return [
		{
			kind: "constant",
			text: `within-distance(${propText}, "`,
		},
		{ kind: "runtime", xpath: center.xpath },
		{
			kind: "constant",
			text: `", ${distanceText}, ${unitText})`,
		},
	];
}

/**
 * Emit `exists` / `missing` per direction. CCHQ exposes two
 * direction-specific query functions:
 *
 *   - `via.kind === "ancestor"` → `ancestor-exists(<slash-joined steps>, <filter>)`
 *     per `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:97-118`.
 *     The first argument is a slash-separated path serialized from
 *     the `RelationStep[]` chain; CCHQ parses it as an ancestor path
 *     expression at `ancestor_functions.py:74-87`.
 *   - `via.kind === "subcase"` → `subcase-exists('<identifier>', <filter>)`
 *     per `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:51-62`.
 *
 * `via.kind === "any-relation"` is direction-agnostic and expands to
 * `(<ancestor-form> or <subcase-form>)` so the predicate matches a
 * related case in either direction. The `missing` form negates the
 * disjunction (`not((ancestor or subcase))`).
 *
 * `via.kind === "self"` has no traversal — it represents
 * "no-relation" semantics with no CSQL wire form. Throws at this
 * layer; the no-traversal author shape composes via direct
 * predicates on the current scope.
 *
 * The optional `where` filter argument routes through the segment
 * walker recursively at `parentPrec: 0` (function-call argument
 * position is its own grouping boundary). The filter's segments
 * splice into the outer call's argument list — runtime refs inside
 * the filter compose into the outer concat, matching CCHQ's
 * canonical pattern at
 * `commcare-hq/docs/case_search_query_language.rst:299-303` where a
 * `subcase-exists("parent", ... clinic_case_id = "', instance(...),
 * '")')` interpolates a runtime user clinic id into the inner CSQL.
 */
function emitExistsSegments(
	p: Extract<Predicate, { kind: "exists" | "missing" }>,
	kind: "exists" | "missing",
): CsqlSegment[] {
	const fragments = emitExistsCallSegments(p);
	if (kind === "missing") {
		return [
			{ kind: "constant", text: "not(" },
			...fragments,
			{ kind: "constant", text: ")" },
		];
	}
	return fragments;
}

function emitExistsCallSegments(
	p: Extract<Predicate, { kind: "exists" | "missing" }>,
): CsqlSegment[] {
	const via = p.via;
	if (via.kind === "self") {
		throw new Error(
			"csqlEmitter: 'exists' / 'missing' with via.kind === 'self' has no CSQL wire form",
		);
	}
	if (via.kind === "any-relation") {
		// Direction-agnostic walk: emit both direction-specific forms
		// and OR them together. A parent `missing` arm wraps the whole
		// disjunction in `not(...)` at the caller (`emitExistsSegments`),
		// mirroring the on-device emitter's any-relation expansion so
		// both dialects expand to `(ancestor or subcase)`.
		const ancestorSegs = emitAncestorExistsCall(
			[{ identifier: via.identifier }],
			p.where,
		);
		const subcaseSegs = emitSubcaseExistsCall(via.identifier, p.where);
		return [
			{ kind: "constant", text: "(" },
			...ancestorSegs,
			{ kind: "constant", text: " or " },
			...subcaseSegs,
			{ kind: "constant", text: ")" },
		];
	}
	if (via.kind === "ancestor") {
		return emitAncestorExistsCall(via.via, p.where);
	}
	return emitSubcaseExistsCall(via.identifier, p.where);
}

/**
 * Emit a single `ancestor-exists('<path>', <filter>)` call. CCHQ's
 * `ancestor-exists` requires exactly two arguments per
 * `confirm_args_count(node, 2)` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:109`.
 * When `where` is absent, inject `match-all()` as the filter — the
 * natural "any case along this ancestor path exists" semantic,
 * expressed in a single grammar-compliant CSQL function. `match-all()`
 * is a CSQL query function at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:52`.
 *
 * The path argument routes through `quoteLiteral` so the
 * slash-joined identifier list emits as a properly-quoted CSQL
 * string literal. Schema-layer regex constraints on each step's
 * `identifier` already restrict the character set; `quoteLiteral`
 * mirrors the property emitters' quoting rule for consistency.
 */
function emitAncestorExistsCall(
	steps: readonly RelationStep[],
	where: Predicate | undefined,
): CsqlSegment[] {
	const path = serializeAncestorPath(steps);
	const pathLiteral = quoteLiteral(path, "csql");
	const filterSegments =
		where !== undefined
			? emitFilterArgumentSegments(where)
			: ([{ kind: "constant", text: "match-all()" }] as const);
	return [
		{ kind: "constant", text: `ancestor-exists(${pathLiteral}, ` },
		...filterSegments,
		{ kind: "constant", text: ")" },
	];
}

/**
 * Emit a single `subcase-exists('<id>', <filter>)` call. CCHQ's
 * `subcase-exists` accepts a 1-or-2-arg form per
 * `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:201`
 * (`if not 1 <= len(args) <= 2`), so the no-where case emits as a
 * single-arg call.
 *
 * The identifier argument routes through `quoteLiteral` for the same
 * reason as `ancestor-exists` — schema constraints already restrict
 * the character set; `quoteLiteral` mirrors the property emitters'
 * quoting rule.
 */
function emitSubcaseExistsCall(
	identifier: string,
	where: Predicate | undefined,
): CsqlSegment[] {
	const identifierLiteral = quoteLiteral(identifier, "csql");
	if (where === undefined) {
		return [{ kind: "constant", text: `subcase-exists(${identifierLiteral})` }];
	}
	const filterSegments = emitFilterArgumentSegments(where);
	return [
		{ kind: "constant", text: `subcase-exists(${identifierLiteral}, ` },
		...filterSegments,
		{ kind: "constant", text: ")" },
	];
}

/**
 * Slash-join a relation-step chain into the path serialization CCHQ
 * parses at `ancestor_functions.py:74-87`. The walker there reads the
 * argument as a binary expression of `Step / Step / ...` nodes, where
 * each `Step` carries a single identifier; serializing the chain as
 * `parent/host` matches the parser's expected shape.
 */
function serializeAncestorPath(steps: readonly RelationStep[]): string {
	return steps.map((s) => s.identifier).join("/");
}

/**
 * Emit a filter predicate's segment list for embedding inside an
 * `ancestor-exists(...)` / `subcase-exists(...)` argument list.
 *
 * The filter executes server-side, but runtime refs (search-input
 * refs, session refs, synthetic hoist refs) compose into the filter
 * argument naturally via the outer `concat(...)` wrapper — see CCHQ's
 * canonical pattern at
 * `commcare-hq/docs/case_search_query_language.rst:299-303`, where
 * `subcase-exists("parent", ... clinic_case_id = "', instance(...),
 * '")')` interpolates a runtime user clinic id inside the
 * subcase-exists filter argument. The runtime XPath result becomes
 * part of the CSQL string the server parses.
 *
 * Each runtime segment in the filter contributes a separate
 * `concat(...)` argument at the outer wrapper layer; the segment
 * list flows through unchanged and is spliced into the parent's
 * segment list at the call site.
 */
function emitFilterArgumentSegments(p: Predicate): CsqlSegment[] {
	return emitPredicateSegments(p, 0);
}

/**
 * Two-shape result for term emission. Constants flow through
 * `quoteConstantSegmentForXPath` at the wrap layer; runtime refs
 * become bare `concat(...)` arguments. Each arm is a named alias
 * (`ConstantTermEmission` / `RuntimeTermEmission`) so emitters that
 * produce only one arm — `emitPropertyRefSegment`, which always
 * returns the constant arm because a property reference is always a
 * compile-time-known identifier — narrow their return type to that
 * alias and lift the dead-branch guarantee into the type system.
 *
 *   - `constant` carries the CSQL wire-form text directly (e.g. a
 *     literal value, a property identifier, a reserved-attribute
 *     `@`-prefix).
 *   - `runtime` carries an XPath path expression evaluated on-device
 *     (e.g. `instance('search-input:results')/input/field[@name='X']`,
 *     `instance('commcaresession')/session/user/data/<field>`,
 *     synthetic hoist refs sharing the search-input wire shape).
 */
type ConstantTermEmission = {
	readonly kind: "constant";
	readonly text: string;
};
type RuntimeTermEmission = { readonly kind: "runtime"; readonly xpath: string };
type TermEmission = ConstantTermEmission | RuntimeTermEmission;

/**
 * Compile a term to its CSQL wire form. Terms with a compile-time-known
 * value (literals, property references) emit as `constant`; terms
 * resolved at runtime against an instance path (search-input refs,
 * session refs, synthetic hoist refs) emit as `runtime`.
 */
function emitTermSegment(t: Term): TermEmission {
	switch (t.kind) {
		case "prop":
			return { kind: "constant", text: emitPropertyRefText(t) };
		case "input":
			return { kind: "runtime", xpath: emitSearchInputXPath(t) };
		case "session-user":
			return { kind: "runtime", xpath: emitSessionUserXPath(t) };
		case "session-context":
			return { kind: "runtime", xpath: emitSessionContextXPath(t) };
		case "literal":
			return emitLiteralSegment(t.value);
		default: {
			const _exhaustive: never = t;
			throw new Error(
				`csqlEmitter: unhandled term kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Compile a property reference to its CSQL identifier text. Reserved
 * case attributes (`case_id`, `case_type`, `owner_id`, `status`) get
 * the `@`-prefix per CCHQ's `INDEXED_METADATA_BY_KEY` registration at
 * `commcare-hq/corehq/apps/case_search/const.py:53-103`. User-defined
 * properties pass through bare.
 *
 * The `via` slot — relation walks reaching a property on a related
 * case — is dropped at this emission layer because CCHQ's CSQL
 * comparison-form for relational reads uses the slash-path shape on
 * the comparison's left side
 * (`<rel>/<prop> = <value>` parsed via `is_ancestor_comparison` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:13-22`),
 * which the emitter does not generate. The intended path for
 * relational reads is `exists` / `missing` predicates that carry the
 * relation walk explicitly.
 */
function emitPropertyRefText(t: PropertyRef): string {
	if (RESERVED_CASE_ATTRIBUTES.has(t.property)) {
		return `@${quoteIdentifier(t.property)}`;
	}
	return quoteIdentifier(t.property);
}

function emitPropertyRefSegment(t: PropertyRef): ConstantTermEmission {
	return { kind: "constant", text: emitPropertyRefText(t) };
}

/**
 * Compile a search-input ref to its CSQL runtime XPath. The wire form
 * `instance('search-input:results')/input/field[@name='<name>']` is
 * the canonical search-input read documented at
 * `commcare-hq/docs/case_search_query_language.rst:299-303` and
 * registered at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py:354`.
 *
 * `name` is constrained at the schema layer to XML element-name
 * vocabulary (no hyphens, no quotes), so direct interpolation is safe.
 */
function emitSearchInputXPath(t: SearchInputRef): string {
	return `instance('search-input:results')/input/field[@name='${t.name}']`;
}

/**
 * Compile a session-user ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/user/data/<field>` reads from
 * the open-namespace custom user-data tree populated by
 * `addUserProperties` in
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`.
 */
function emitSessionUserXPath(t: SessionUserRef): string {
	return `instance('commcaresession')/session/user/data/${t.field}`;
}

/**
 * Compile a session-context ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/context/<field>` reads from
 * the closed-namespace framework-controlled context tree populated by
 * `addMetadata` in
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`.
 */
function emitSessionContextXPath(t: SessionContextRef): string {
	return `instance('commcaresession')/session/context/${t.field}`;
}

/**
 * Compile a literal to its CSQL wire-form constant text. Numeric
 * literals route through `formatNumeric` to dodge XPath's
 * exponent-form rejection; boolean literals emit as the strings
 * `'true'` / `'false'` matching CCHQ's case-property storage shape;
 * `null` literals emit as `''` (the natural absent / empty form).
 * String literals route through `quoteLiteral(value, "csql")` for
 * the per-dialect single↔double quote-style escape.
 */
function emitLiteralSegment(
	value: string | number | boolean | null,
): TermEmission {
	if (value === null) return { kind: "constant", text: "''" };
	if (typeof value === "number") {
		return { kind: "constant", text: formatNumeric(value) };
	}
	if (typeof value === "boolean") {
		return { kind: "constant", text: value ? "'true'" : "'false'" };
	}
	return { kind: "constant", text: quoteLiteral(value, "csql") };
}

/**
 * Unwrap the `term` arm of a `ValueExpression`. Predicate-operand
 * slots accept any ValueExpression, but the CSQL emitter handles
 * non-term arms via the hoist pass — by the time a predicate reaches
 * the emission walker, every operand slot is guaranteed to carry a
 * `term`-arm wrapper (either an author-written term or a synthetic
 * hoist ref). Any other arm reaching this helper indicates the hoist
 * pass missed a non-grammar shape, which is a programming error
 * at the AST → emitter boundary.
 */
function unwrapTermFromExpression(expr: ValueExpression): Term {
	if (expr.kind === "term") return expr.term;
	throw new Error(
		`csqlEmitter: ValueExpression arm '${expr.kind}' reached the term emitter; the hoist pass should have lifted it`,
	);
}

/**
 * Coalesce adjacent constant segments into one. Centralised at the
 * wrap layer so per-arm emitters produce raw segment lists without
 * needing their own merge passes. Without this pass, a predicate
 * like `eq(prop, literal("a")) and eq(prop, literal("b"))` would
 * emit four adjacent constant segments around the `' and '`
 * separator; the merge keeps the segment list to one constant per
 * contiguous constant run.
 *
 * Runtime segments pass through untouched — they always sit as their
 * own segment because `concat(...)` argument boundaries are the one
 * place a constant↔runtime transition is authoritative.
 */
function mergeAdjacentConstants(
	segments: readonly CsqlSegment[],
): CsqlSegment[] {
	const merged: CsqlSegment[] = [];
	for (const seg of segments) {
		const last = merged[merged.length - 1];
		if (
			seg.kind === "constant" &&
			last !== undefined &&
			last.kind === "constant"
		) {
			merged[merged.length - 1] = {
				kind: "constant",
				text: last.text + seg.text,
			};
			continue;
		}
		merged.push(seg);
	}
	return merged;
}
