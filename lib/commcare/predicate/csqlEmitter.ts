// lib/commcare/predicate/csqlEmitter.ts
//
// Per-dialect emitter producing the on-device XPath wrapper that builds
// a CSQL `_xpath_query` string at runtime. CSQL is the server-side
// dialect evaluated by ElasticSearch on the CCHQ server when a
// case-search remote-request fires; the wire form is documented at
// `commcare-hq/docs/case_search_query_language.rst`. Two CSQL function
// whitelists on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
// and `__init__.py::XPATH_QUERY_FUNCTIONS` constrain what the inner
// CSQL fragment may contain.
//
// The emitter runs a three-stage pipeline:
//
//   1. Run the property-via lift pre-pass (`csqlHoist.ts::liftPropertyVias`).
//      Every operator-direct `prop(via)` reference rewrites into an
//      enclosing `exists` envelope so the relation walk emits as
//      CCHQ's direction-specific query function. After the pre-pass
//      every property reference reaching the segment walker has
//      `via.kind === "self"` (or no `via` slot).
//   2. Walk the lifted AST emitting a `CsqlSegment[]` IR — each
//      segment is either a constant CSQL fragment or a runtime XPath
//      expression that produces a string interpolated into the CSQL
//      fragment at runtime. Non-grammar value expressions (`if`,
//      `switch`, `arith`, `concat`, `coalesce`, `format-date`,
//      ancestor / any-relation `count`, and `count` outside the
//      comparison-LHS subcase position) emit inline as runtime XPath
//      via `emitOnDeviceExpression`, NOT as separate `<data>` slots —
//      see the file header for why a sibling `<data>` slot is
//      structurally wrong on the CCHQ runtime.
//   3. Map the segment list into a `concat(...)` XPath expression — the
//      canonical CCHQ pattern documented in
//      `commcare-hq/docs/case_search_query_language.rst`. Every
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
// without an embedded-quote conflict — the canonical CCHQ pattern
// documented in `case_search_query_language.rst`. Constant-only string
// emissions route through `quoteLiteral(value, "csql")` from
// `stringQuoting.ts`, which uses single-quoted CSQL by default and
// switches to double-quoted CSQL when the value contains a single
// quote. The two strategies coexist because the runtime-interpolation
// arm has no compile-time knowledge of the user's typed value, so the
// wire form must commit to one quote style at emit time and the
// double-quoted form is the one CCHQ's documented examples use.
//
// Inline-runtime contract for non-grammar value expressions:
//
// CCHQ's `RemoteQuerySessionManager.initUserAnswers` at
// `commcare-core/.../session/RemoteQuerySessionManager.java` only
// threads values into the `search-input:results` instance from
// `<prompt>` elements' `getDefaultValueExpr()`. Synthetic search-
// input keys emitted as sibling `<data>` slots never reach the
// instance — `getUserQueryValues` iterates `queryPrompts` only —
// so an XPath expression that reads
// `instance('search-input:results')/input/field[@name='<synthetic>']`
// resolves to the empty string at evaluation time and the surrounding
// CSQL position substitutes empty. Worse, the sibling `<data>`'s
// evaluated value DOES go to URL parameters, and CCHQ's server
// `case_search/utils.py::_apply_filter` falls through to
// `_get_case_property_query` for any non-`UNSEARCHABLE_KEYS` key,
// adding an ES query requiring `case_property("<synthetic>") ==
// <value>` against case data — which matches zero cases.
//
// The canonical CCHQ pattern at
// `case_search_query_language.rst::"Example Query + Tips"` inlines
// the on-device expression directly into the `concat(...)` instead.
// `instance('casedb')/...` evaluates on-device at concat-time and
// produces a literal string; the result substitutes inline into the
// CSQL fragment. This is the shape Nova emits — `emitOnDeviceExpression`
// produces the runtime XPath fragment and it lands as a single
// `runtime` segment inside the outer concat.
//
// Operand-side ValueExpression dispatch:
//
//   - `term` arms unwrap to terms via the shared term emitter.
//   - The eight CSQL value-function whitelist arms (`today`, `now`,
//     `date-coerce`, `datetime-coerce`, `double`, `date-add`,
//     `unwrap-list`, plus the `term` lifter) emit through the value-
//     expression emitter at `lib/commcare/expression/csqlEmitter.ts`
//     so the result is CSQL the server parses natively.
//   - `count` with `via.kind === "subcase"` in comparison-LHS slot
//     emits as native `subcase-count(...)` per CCHQ's `_is_subcase_count`
//     recogniser nested inside
//     `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`.
//   - The non-whitelist arms (`arith`, `concat`, `coalesce`, `if`,
//     `switch`, `format-date`, plus every other `count` shape) emit
//     as a single runtime XPath fragment via `emitOnDeviceExpression`,
//     wrapped in CSQL double-quote brackets at the comparison-operand
//     site so the resolved runtime string interpolates as a CSQL
//     string value. CCHQ's server-side `case_property_query` handles
//     type coercion, so the double-quote wrap is uniform whether the
//     resolved value parses as a number, string, or date.

import type {
	ComparisonKind,
	Predicate,
	RelationStep,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { emitCsqlExpressionSegments } from "../expression/csqlEmitter";
import { emitOnDeviceExpression } from "../expression/onDeviceEmitter";
import { liftPropertyVias } from "./csqlHoist";
import {
	type CsqlSegment,
	mergeAdjacentConstants,
	quoteConstantSegmentForXPath,
} from "./csqlSegment";
import { formatNumeric, quoteLiteral } from "./stringQuoting";
import {
	emitCsqlPropertyRefSegment,
	emitCsqlPropertyRefText,
	emitSearchInputXPath,
	emitTermSegment,
	serializeAncestorPath,
	wrapTermAsSegmentList,
} from "./termEmitter";

/**
 * Output of the CSQL emission pipeline. `wrapper` is the on-device
 * XPath expression that builds the CSQL `_xpath_query` string at
 * runtime. It is always a `concat(...)` call regardless of whether
 * any segments interpolate a runtime value, so the wire layer can
 * drop it into a `<data key="_xpath_query" ref="...">` slot
 * uniformly.
 *
 * No sibling `<data>` slots are produced — non-grammar value
 * expressions inline as runtime XPath fragments inside the concat.
 * See the file header's inline-runtime contract for the CCHQ
 * runtime reason this is the only correct shape.
 */
export interface CsqlEmissionResult {
	readonly wrapper: string;
}

/**
 * Comparison-operator AST kind → CSQL wire token. CSQL inherits the
 * six XPath-1.0 binary comparison operators (`=`, `!=`, `<`, `<=`,
 * `>`, `>=`); the parser dispatches them through
 * `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
 * (the inner `_comparison` calls `property_comparison_query`),
 * drawing the comparator set from
 * `commcare-hq/corehq/apps/case_search/const.py::COMPARISON_OPERATORS`
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
 * Position discriminator threaded through the operand walker so the
 * `count` arm can decide whether to emit as native CSQL or inline as
 * an on-device XPath fragment.
 *
 *   - `comparison-operand` — directly underneath one of the six
 *     comparison operators. `count` with `via.kind === "subcase"`
 *     survives here as native `subcase-count(...)`.
 *   - `value` — every other ValueExpression slot. All count shapes
 *     inline as on-device XPath.
 */
type OperandPosition = "comparison-operand" | "value";

/**
 * Top-level entry point. Lifts vias, emits, wraps in `concat(...)`.
 * The lift pass is total — every input AST reaches the segment
 * walker with via-free operator-direct property refs.
 *
 * `emitCsql` is the public entry; internal callers that already hold
 * a via-lifted AST (e.g. the `when-input-present` recursive emitter)
 * call `emitLiftedWrapper` directly to skip the redundant scan.
 */
export function emitCsql(predicate: Predicate): CsqlEmissionResult {
	const lifted = liftPropertyVias(predicate);
	return { wrapper: emitLiftedWrapper(lifted) };
}

/**
 * Internal entry that takes a pre-lifted predicate and produces the
 * `concat(...)` wrapper string. Used by the recursive emitter for
 * `when-input-present` (where the inner clause is already lifted as
 * part of the outer via-lift walk).
 */
function emitLiftedWrapper(predicate: Predicate): string {
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
			// CCHQ's zero-arg query function `match-all` registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
			return [{ kind: "constant", text: "match-all()" }];
		case "match-none":
			// CCHQ's zero-arg query function `match-none` registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
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
			// `not(...)` is in CCHQ's query-function whitelist on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
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
			// `commcare-hq/corehq/apps/es/case_search.py::case_property_query`,
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
				`csqlEmitter: hit an unhandled predicate kind '${String(_exhaustive)}' while emitting CSQL segments. Expected one of the kinds listed on the Predicate union in lib/domain/predicate/types.ts. Whoever added the kind needs to extend the emission dispatch.`,
			);
		}
	}
}

/**
 * Emit `when-input-present(trigger, clause)` as the canonical CCHQ
 * pattern at
 * `case_search_query_language.rst::"Filtering on related cases" → "Examples"`:
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
 * The inner clause is already via-lifted by the outer `liftPropertyVias`
 * call (which walked into `p.clause`), so this emitter calls
 * `emitLiftedWrapper` directly rather than re-running the lift.
 *
 * The `if(...)` wrapper expression flows out as a single runtime
 * segment in the outer concat, exactly the shape used elsewhere for
 * search-input refs.
 */
function emitWhenInputPresentSegments(
	p: Extract<Predicate, { kind: "when-input-present" }>,
): CsqlSegment[] {
	const triggerXPath = emitSearchInputXPath(p.input);
	const innerWrapper = emitLiftedWrapper(p.clause);
	const conditionalXPath = `if(count(${triggerXPath}), ${innerWrapper}, 'match-all()')`;
	return [{ kind: "runtime", xpath: conditionalXPath }];
}

/**
 * Emit a comparison predicate. The LHS routes through
 * `emitComparisonOperandSegments` so a `count(subcasePath, ...)`
 * surface as native `subcase-count(...)` per CCHQ's `_is_subcase_count`
 * recogniser nested inside
 * `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`,
 * which only inspects `node.left`. The RHS routes through the `value`
 * position so a `count` shape inlines as on-device XPath — CCHQ's
 * RHS dispatcher (`property_comparison_query` →
 * `dsl_utils.py::unwrap_value`) only accepts `XPATH_VALUE_FUNCTIONS`
 * entries; `subcase-count` lives in `XPATH_QUERY_FUNCTIONS` and
 * would be rejected with `"We don't know what to do with the
 * function 'subcase-count'"` on the wire. Inlining as on-device
 * XPath produces a numeric literal that the RHS dispatcher accepts.
 */
function emitComparisonSegments(
	p: Extract<Predicate, { kind: ComparisonKind }>,
): CsqlSegment[] {
	const leftSegs = emitOperandSegments(p.left, "comparison-operand");
	const rightSegs = emitOperandSegments(p.right, "value");
	const op = COMPARISON_OPS[p.kind];
	return [...leftSegs, { kind: "constant", text: ` ${op} ` }, ...rightSegs];
}

/**
 * Compile a comparison operand to a segment list. CSQL's value-
 * position wire form for runtime-resolved values uses double-quoted
 * brackets (`<prop> = "<runtime-value>"`) per the canonical pattern
 * documented in `commcare-hq/docs/case_search_query_language.rst`;
 * this emitter is responsible for that wrap layer.
 *
 * Operand-shape dispatch (in priority order):
 *
 *   1. `count(subcasePath, ...)` — CCHQ's recognised `subcase-count`
 *      form per `_is_subcase_count` nested inside
 *      `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`.
 *      The filter argument's segments splice inline so any runtime
 *      refs compose into the outer concat. Other `count` shapes
 *      (ancestor / any-relation direction, or `count` outside the
 *      comparison-LHS slot) inline as on-device XPath via the
 *      catch-all branch below.
 *   2. Non-grammar value expression — `if`, `switch`, `arith`,
 *      `concat`, `coalesce`, `format-date`, and every other `count`
 *      shape. Emits as a single runtime segment wrapping
 *      `emitOnDeviceExpression(expr)`, double-quote-bracketed so the
 *      resolved string interpolates as a CSQL value.
 *   3. `term`-arm ValueExpression — wrap via the shared
 *      `wrapTermAsSegmentList` helper so a runtime-resolved term
 *      interpolates as a CSQL double-quoted value.
 *   4. CSQL value-function whitelist arm (`today`, `now`,
 *      `date-coerce`, `datetime-coerce`, `double`, `date-add`,
 *      `unwrap-list`) — delegates to the value-expression emitter at
 *      `lib/commcare/expression/csqlEmitter.ts`. The wire form is
 *      the function-call result which CCHQ's grammar accepts as a
 *      value directly.
 */
function emitComparisonOperandSegments(expr: ValueExpression): CsqlSegment[] {
	return emitOperandSegments(expr, "comparison-operand");
}

/**
 * Per-position operand emitter. `comparison-operand` admits native
 * `subcase-count`; `value` (any other ValueExpression slot) does
 * not — those `count` shapes inline as on-device XPath.
 */
function emitOperandSegments(
	expr: ValueExpression,
	position: OperandPosition,
): CsqlSegment[] {
	if (expr.kind === "count") {
		if (position === "comparison-operand" && expr.via.kind === "subcase") {
			// CCHQ's `_is_subcase_count` recogniser only matches a
			// `subcase-count(...)` function call sitting directly on a
			// comparison's LHS. The filter argument's segments splice
			// inline so any runtime refs nested inside compose into the
			// outer concat.
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
		// Non-LHS `count`, or comparison-LHS `count` with ancestor /
		// any-relation direction: no native CSQL form. Inline as
		// on-device XPath; the runtime resolves the count to a number
		// and the result substitutes into the CSQL string as a
		// double-quoted value.
		return inlineAsRuntimeOperand(expr);
	}
	if (expr.kind === "term") {
		return wrapTermAsSegmentList(emitTermSegment(expr.term));
	}
	if (isCsqlValueFunctionArm(expr)) {
		// Whitelist arms (`today`, `now`, `date-coerce`,
		// `datetime-coerce`, `double`, `date-add`, `unwrap-list`)
		// delegate to the value-expression emitter for native CSQL.
		return emitCsqlExpressionSegments(expr);
	}
	// Catch-all: `arith`, `concat`, `coalesce`, `if`, `switch`,
	// `format-date`. These are absent from CSQL's value-function
	// whitelist on
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`,
	// so the only wire-correct shape is to evaluate the expression
	// on-device at concat-time and inline the resolved string into
	// the CSQL fragment. See the file header for why a sibling
	// `<data>` slot is structurally wrong on the CCHQ runtime.
	return inlineAsRuntimeOperand(expr);
}

/**
 * Compile a non-grammar value expression into a runtime segment
 * wrapped in CSQL double-quote brackets. The on-device emitter
 * produces an XPath expression that resolves to a string at concat-
 * evaluation time; the surrounding `"..."` makes the resolved value
 * land as a CSQL string literal in the rendered fragment. CCHQ's
 * server-side `case_property_query` coerces the resulting string to
 * the property's type, so the wrap is uniform whether the resolved
 * value is logically a number, date, or string.
 *
 * Matches the canonical CCHQ pattern at
 * `case_search_query_language.rst::"Example Query + Tips"` where
 * `subcase-exists("parent", ... selected(clinic_case_id,"', instance(...),
 * '"))')` interpolates a runtime user clinic id directly into the
 * CSQL fragment.
 */
function inlineAsRuntimeOperand(expr: ValueExpression): CsqlSegment[] {
	const xpath = emitOnDeviceExpression(expr);
	return [
		{ kind: "constant", text: '"' },
		{ kind: "runtime", xpath },
		{ kind: "constant", text: '"' },
	];
}

/**
 * Recognise the eight CSQL value-function whitelist arms — the only
 * `ValueExpression` kinds that emit through the value-expression
 * CSQL emitter (which produces native CSQL the server parses).
 *
 * Every other ValueExpression kind inlines as on-device XPath via
 * `inlineAsRuntimeOperand`. Centralising the whitelist check here
 * keeps the per-arm dispatch in `emitOperandSegments` to one
 * straight-line if/else chain.
 */
function isCsqlValueFunctionArm(expr: ValueExpression): boolean {
	switch (expr.kind) {
		case "today":
		case "now":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "date-add":
		case "unwrap-list":
			return true;
		default:
			return false;
	}
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
 * `commcare-hq/corehq/apps/es/case_search.py::case_property_text_query`
 * forwards to; `selected-any` would silently break `in` semantics on
 * multi-word values.
 */
function emitInSegments(p: Extract<Predicate, { kind: "in" }>): CsqlSegment[] {
	const left = emitComparisonOperandSegments(p.left);
	if (p.values.length === 1) {
		const right = wrapTermAsSegmentList(
			emitTermSegment({ kind: "literal", value: p.values[0].value }),
		);
		return [...left, { kind: "constant", text: " = " }, ...right];
	}
	// Multi-value — wrap the OR-of-equalities in parens defensively so a
	// parent `and` cannot re-associate the chain.
	const parts: CsqlSegment[] = [{ kind: "constant", text: "(" }];
	for (let i = 0; i < p.values.length; i += 1) {
		if (i > 0) parts.push({ kind: "constant", text: " or " });
		const right = wrapTermAsSegmentList(
			emitTermSegment({ kind: "literal", value: p.values[i].value }),
		);
		parts.push(...left, { kind: "constant", text: " = " }, ...right);
	}
	parts.push({ kind: "constant", text: ")" });
	return parts;
}

/**
 * Emit a `between` predicate by expanding into the conjunction of two
 * boundary comparisons. CSQL recognises the six binary comparison
 * operators per
 * `commcare-hq/corehq/apps/case_search/const.py::COMPARISON_OPERATORS`;
 * expanding `between` keeps the wire form within that vocabulary.
 *
 * The `lowerInclusive` / `upperInclusive` flags pick the per-bound
 * operator (`>=` / `>` for the lower, `<=` / `<` for the upper). When
 * only one bound is present, the predicate degenerates to a single
 * comparison without the conjunction wrap.
 *
 * Operand-position discrimination: `left` sits on the LHS of both
 * lowered comparisons, so `comparison-operand` routing is right
 * (CCHQ's `_is_subcase_count` recogniser fires on the LHS of a
 * BinaryExpression, so a subcase-direction `count` survives as
 * native `subcase-count(...)`). `lower` / `upper` sit on the RHS,
 * where `_is_subcase_count` doesn't reach — those slots route
 * through the `value` position so any `count` shape inlines as
 * on-device XPath rather than emitting `prop >= subcase-count(...)`
 * which CCHQ's runtime would parse as a literal value-side function
 * call against ElasticSearch and fail.
 */
function emitBetweenSegments(
	p: Extract<Predicate, { kind: "between" }>,
): CsqlSegment[] {
	const left = emitComparisonOperandSegments(p.left);
	const lowerOp = p.lowerInclusive ? ">=" : ">";
	const upperOp = p.upperInclusive ? "<=" : "<";
	const lowerSegs =
		p.lower !== undefined ? emitOperandSegments(p.lower, "value") : undefined;
	const upperSegs =
		p.upper !== undefined ? emitOperandSegments(p.upper, "value") : undefined;
	if (lowerSegs !== undefined && upperSegs !== undefined) {
		// Wrap the conjunction in parens unconditionally so a parent
		// `or` cannot re-associate the chain. Wrapping at every
		// `between` emission costs one redundant pair when the predicate
		// sits at the outermost level; that's the same trade-off the
		// `in` multi-value branch makes.
		return [
			{ kind: "constant", text: "(" },
			...left,
			{ kind: "constant", text: ` ${lowerOp} ` },
			...lowerSegs,
			{ kind: "constant", text: " and " },
			...left,
			{ kind: "constant", text: ` ${upperOp} ` },
			...upperSegs,
			{ kind: "constant", text: ")" },
		];
	}
	if (lowerSegs !== undefined) {
		return [...left, { kind: "constant", text: ` ${lowerOp} ` }, ...lowerSegs];
	}
	if (upperSegs !== undefined) {
		return [...left, { kind: "constant", text: ` ${upperOp} ` }, ...upperSegs];
	}
	// Schema's `.refine()` rejects the both-bounds-absent shape;
	// keep the branch defensive in case a pre-validated AST reaches
	// this emitter with both bounds stripped.
	throw new Error(
		"csqlEmitter: tried to emit a 'between' predicate that carries neither a lower nor an upper bound. The between schema rejects this shape at authoring time, so reaching this throw means the AST was constructed at runtime or coerced past validation. Run validation before invoking the compile pipeline.",
	);
}

/**
 * Emit `is-blank` / `is-null` as `<term> = ''`. CCHQ's server-side
 * `case_property_query()` at
 * `commcare-hq/corehq/apps/es/case_search.py::case_property_query`
 * short-circuits `value == ''` to `case_property_missing()` semantics,
 * matching absent / cleared / empty alike on every CSQL emission. The
 * two predicate kinds map to the same wire form because CSQL has no
 * mechanism for distinguishing strict-absent from cleared from empty
 * — `is-null`'s strict-absent semantic surfaces only on the Postgres
 * target where JSONB key presence is observable.
 */
function emitAbsenceSegments(
	p: Extract<Predicate, { kind: "is-blank" | "is-null" }>,
): CsqlSegment[] {
	const left = emitComparisonOperandSegments(p.left);
	return [...left, { kind: "constant", text: " = ''" }];
}

/**
 * Emit a `match` predicate. Each mode maps to a CCHQ query function
 * registered on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`:
 *
 *   - `fuzzy` → `fuzzy-match` (ES `queries.fuzzy` against
 *     `PROPERTY_VALUE`; implementation at `query_functions.py::fuzzy_match`).
 *   - `phonetic` → `phonetic-match` (Soundex via
 *     `sounds_like_text_query`; implementation at
 *     `query_functions.py::phonetic_match`).
 *   - `fuzzy-date` → `fuzzy-date` (digit-permutation
 *     date match at `query_functions.py::fuzzy_date`).
 *   - `starts-with` → `starts-with`
 *     (`case_property_starts_with` at `query_functions.py::starts_with`).
 *
 * `value` is a plain string — the schema rejects empty values per
 * `matchSchema`'s `.min(1)` rule. The property reference flows through
 * the shared CSQL property-emitter so the reserved-attribute prefix
 * logic applies.
 */
function emitMatchSegments(
	p: Extract<Predicate, { kind: "match" }>,
): CsqlSegment[] {
	const wireFunction = matchModeToWireFunction(p.mode);
	const propEmission = emitCsqlPropertyRefSegment(p.property);
	// `match.value` is a term-arm `ValueExpression` (per the type
	// checker's `checkMatch` rule). Non-term arms are rejected at
	// type-check time; reaching this throw indicates a bypass.
	if (p.value.kind !== "term") {
		throw new Error(
			`csqlEmitter: tried to emit a 'match' predicate with a non-term value of kind '${p.value.kind}'. The type checker's checkMatch rule rejects this shape at authoring time, so reaching this throw means an AST was built at runtime or coerced past validation. Wrap the value as a term-arm ValueExpression or run validation before invoking the compile pipeline.`,
		);
	}
	// Term-arm value compiles via the shared `emitTermSegment`, then
	// routes through `wrapTermAsSegmentList` so the wire form holds
	// the canonical CSQL value-position contract:
	//
	//   - Literal terms emit a self-quoted CSQL string (`'alice'`)
	//     and pass through `wrapTermAsSegmentList` unchanged.
	//   - Runtime terms (search-input / session refs) emit as a raw
	//     XPath path expression and wrap in `"..."` so the resolved
	//     runtime string interpolates as a CSQL string value rather
	//     than a path.
	//
	// CCHQ's `commcare-hq/corehq/apps/case_search/dsl_utils.py::unwrap_value`
	// rejects a bare `Step` (path) AST node with `CaseFilterError`
	// (`"You cannot reference a case property on the right side..."`).
	// Every other operand emission in this file routes runtime terms
	// through the same wrap — the `match` arm was the lone bypass.
	const valueSegments = wrapTermAsSegmentList(emitTermSegment(p.value.term));
	return [
		{ kind: "constant", text: `${wireFunction}(${propEmission.text}, ` },
		...valueSegments,
		{ kind: "constant", text: ")" },
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
				`csqlEmitter: hit an unhandled match mode '${String(_exhaustive)}' while picking a CSQL wire function. Expected fuzzy, phonetic, fuzzy-date, or starts-with. Whoever added the mode needs to extend the dispatch.`,
			);
		}
	}
}

/**
 * Emit a `multi-select-contains` predicate. Each authored value emits
 * as its own `selected(prop, 'v')` call; multi-value forms compose
 * the per-value calls via XPath `or` / `and` per the quantifier.
 * Single-value collapses to one bare `selected(prop, 'v')`.
 *
 * The per-value expansion preserves the structure-of-clauses contract
 * (each authored value contributes one OR/AND clause; a quantifier
 * flip from `any` to `all` lands as `and` instead of `or` at the
 * right granularity).
 *
 * CCHQ's runtime is fragmented on the matching semantic for
 * `selected(prop, value)` — accepted Dimagi-side, not a Nova choice:
 *
 *   - Server: CCHQ aliases `'selected'` to `selected_any` at
 *     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
 *     (`'selected': selected_any,  # selected and selected_any function identically`).
 *     `selected_any` dispatches through `_selected_query` →
 *     `case_property_query(..., multivalue_mode='or')` →
 *     `case_property_text_query` at
 *     `commcare-hq/corehq/apps/es/case_search.py::case_property_text_query`,
 *     which forwards to ElasticSearch's `match` query. The ES
 *     `match` query tokenizes the value argument on whitespace and
 *     OR-matches the tokens (`"If the value has multiple words,
 *     they will be OR'd together"` per the docstring on
 *     `case_property_text_query`).
 *   - On-device: `commcare-core/.../org/javarosa/xpath/expr/XPathSelectedFunc.java::multiSelected`
 *     does space-delimited substring containment without internal
 *     tokenization (`(" " + s1 + " ").contains(" " + s2 + " ")`).
 *
 * Single-token values match equivalently on both runtimes. Multi-word
 * values diverge — the server matches any token; on-device requires
 * the exact space-delimited substring. The validator rule
 * `matchModeWhitespaceInValue` rejects multi-word values for the
 * mode/quantifier combinations that exhibit the divergence, so the
 * authoring layer surfaces the issue before compile.
 *
 * Each value flows through `quoteLiteral` so embedded quotes route
 * through the CSQL escape rule. Null values lower to the wire-form
 * empty string (matching the AST schema's all-null rejection at
 * `multiSelectContainsSchema.refine`).
 */
function emitMultiSelectSegments(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
): CsqlSegment[] {
	const propText = emitCsqlPropertyRefText(p.property);
	const calls = p.values.map((v) => {
		const valueLiteral = quoteLiteral(stringifyLiteralValue(v.value), "csql");
		return `selected(${propText}, ${valueLiteral})`;
	});
	if (calls.length === 1) {
		return [{ kind: "constant", text: calls[0] as string }];
	}
	// Parenthesize the disjunction / conjunction defensively so a
	// parent `and` / `or` cannot re-associate the chain — same wrap
	// the `in`-multi-value branch applies.
	const joiner = p.quantifier === "any" ? " or " : " and ";
	return [{ kind: "constant", text: `(${calls.join(joiner)})` }];
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
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`.
 * The function's signature: `confirm_args_count(node, 4)` →
 * (1) property name (string), (2) coordinate string parsed via
 * `GeoPoint.from_string`, (3) numeric distance (parsed via `float`),
 * (4) unit identifier validated against
 * `commcare-hq/corehq/apps/es/queries.py::DISTANCE_UNITS`.
 *
 * The center coordinate is a ValueExpression slot — usually a
 * `literal("<lat,lon>")` term but possibly a search-input ref for
 * runtime user-typed coordinates. The standard `value`-position
 * operand emitter handles literal / search-input refs / non-grammar
 * inline expressions uniformly via `emitOperandSegments`.
 */
function emitWithinDistanceSegments(
	p: Extract<Predicate, { kind: "within-distance" }>,
): CsqlSegment[] {
	const propText = emitCsqlPropertyRefText(p.property);
	const centerSegments = emitOperandSegments(p.center, "value");
	const distanceText = formatNumeric(p.distance);
	const unitText = quoteLiteral(p.unit, "csql");
	return [
		{ kind: "constant", text: `within-distance(${propText}, ` },
		...centerSegments,
		{ kind: "constant", text: `, ${distanceText}, ${unitText})` },
	];
}

/**
 * Emit `exists` / `missing` per direction. CCHQ exposes two
 * direction-specific query functions:
 *
 *   - `via.kind === "ancestor"` → `ancestor-exists(<slash-joined steps>, <filter>)`
 *     per `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`.
 *     The first argument is a slash-separated path serialized from
 *     the `RelationStep[]` chain; CCHQ parses it as an ancestor path
 *     expression at `ancestor_functions.py::_is_ancestor_path_expression`.
 *   - `via.kind === "subcase"` → `subcase-exists('<identifier>', <filter>)`
 *     per `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::subcase`.
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
 * canonical pattern documented in
 * `commcare-hq/docs/case_search_query_language.rst` where a
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
			"csqlEmitter: tried to emit an 'exists' / 'missing' predicate with a self-walk relation, but CSQL has no wire form for the no-traversal case. Authors expressing 'this case satisfies the filter' compose direct predicates on the current scope instead. Run validation before invoking the compile pipeline; the case-list validator surfaces this shape at authoring time.",
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
 * Emit a single `ancestor-exists(<bare-path>, <filter>)` call. CCHQ's
 * `ancestor-exists` requires exactly two arguments
 * (`commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`)
 * AND the first argument must parse as a path expression — `Step` or
 * a chain of `Step / Step / ...` — per
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_is_ancestor_path_expression`.
 * The walker `walk_ancestor_hierarchy` treats anything else (in
 * particular a string Literal) as a non-path: it never enters the
 * walking loop, serializes the Literal back to a quoted string, and
 * runs `reverse_index_case_query(case_ids, "'parent'")` against an
 * index whose `identifier` is literally `'parent'` — a property no
 * real case carries, so the server silently returns zero matches.
 *
 * The bare path is wire-safe because schema constraints on each
 * `RelationStep.identifier` already restrict the character set to
 * the CCHQ identifier shape, and `serializeAncestorPath` slash-joins
 * them into the exact `parent` / `parent/host` form the CCHQ
 * grammar consumes.
 *
 * When `where` is absent, the call inlines `match-all()` as the
 * filter — the natural "any case along this ancestor path exists"
 * semantic, expressed in a single grammar-compliant CSQL function.
 * `match-all()` is registered on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
 *
 * Contrast `subcase-exists`: its first argument is a string
 * identifier (`_extract_subcase_query_parts` enforces
 * `isinstance(index_identifier, str)`), so that emitter keeps the
 * `quoteLiteral` wrap. The two CCHQ functions look symmetric on the
 * surface but have inverted first-arg contracts.
 */
function emitAncestorExistsCall(
	steps: readonly RelationStep[],
	where: Predicate | undefined,
): CsqlSegment[] {
	const barePath = serializeAncestorPath(steps);
	const filterSegments =
		where !== undefined
			? emitFilterArgumentSegments(where)
			: ([{ kind: "constant", text: "match-all()" }] as const);
	return [
		{ kind: "constant", text: `ancestor-exists(${barePath}, ` },
		...filterSegments,
		{ kind: "constant", text: ")" },
	];
}

/**
 * Emit a single `subcase-exists('<id>', <filter>)` call. CCHQ's
 * `subcase-exists` accepts a 1-or-2-arg form per
 * `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::_extract_subcase_query_parts`
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
 * Emit a filter predicate's segment list for embedding inside an
 * `ancestor-exists(...)` / `subcase-exists(...)` argument list.
 *
 * The filter executes server-side, but runtime refs (search-input
 * refs, session refs, inlined non-grammar value expressions) compose
 * into the filter argument naturally via the outer `concat(...)`
 * wrapper — see CCHQ's canonical pattern at
 * `case_search_query_language.rst::"Filtering on related cases" → "Examples"`,
 * where `subcase-exists("parent", ... clinic_case_id = "', instance(...),
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
