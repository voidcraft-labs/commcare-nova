// lib/commcare/expression/onDeviceEmitter.ts
//
// Per-dialect value-expression emitter for CommCare's on-device XPath
// dialect. Produces wire strings usable in any on-device value slot:
// calculated columns, sort keys, the late-flag column's date
// argument, the source of an ID-mapping column, search-input default
// values, the conditional-clause branches inside a predicate's `if` /
// `switch`, the per-iteration value of a `format-date`, etc. The wire
// strings drop into both the case-list `<detail nodeset>` slot and
// the post-ES `<search_filter>` slot — both run on the same on-device
// XPath evaluator, so the wire form is identical regardless of slot.
//
// Emission policy: total. Every `ValueExpression` AST node produces a
// well-formed XPath expression. Nova emits the maximum CCHQ-supported
// feature subset; runtime player capabilities are Dimagi's concern,
// not a structural concern in this emitter.
//
// File ownership: this file owns operator dispatch for the on-device
// expression dialect. Lexical concerns (string quoting, identifier
// emission, numeric formatting) flow through the shared `../predicate/
// stringQuoting` helpers; term emission and relation-walk anchors flow
// through the shared `../predicate/termEmitter` helpers; the cross-
// family `if` / `switch` / `count` arms call the on-device predicate
// emitter (`../predicate/caseListFilterEmitter:emitCaseListFilter`)
// for their conditional-clause slots.
//
// Operator surface (every arm of `ValueExpression`):
//
//   - `today` / `now` — discriminator-only. Emit `today()` / `now()`
//     (zero-arg value functions registered on
//     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`;
//     also XPath 1.0 standard functions).
//   - `date-coerce(value)` → `date(<value>)`; `datetime-coerce(value)`
//     → `datetime(<value>)`. The AST kind name diverges from the wire
//     function name intentionally — authors see semantic naming
//     (`dateCoerce(...)`) while the wire layer uses CCHQ's vocabulary.
//   - `double(value)` → `double(<value>)`. CCHQ's forced numeric
//     coercion value function on
//     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
//   - `arith(left, op, right)` → `(<left> <op> <right>)`. The five
//     CCHQ-vocabulary operators (`+`, `-`, `*`, `div`, `mod`); paren-
//     wrapping is unconditional so a recursive composition stays
//     parse-stable without a precedence walker.
//   - `concat(parts)` → `concat(<part1>, <part2>, ...)`. XPath 1.0
//     standard string-concatenation function.
//   - `coalesce(parts)` → `coalesce(<part1>, <part2>, ...)`. CCHQ
//     coalesce value function (also XPath 1.0 standard via
//     `XpathCoalesceFunc` in commcare-core).
//   - `if(cond, then, else)` → `if(<predicate-emit(cond)>, <then>,
//     <else>)`. The condition is a `Predicate`; recurse through the
//     on-device predicate emitter. CCHQ wire form per
//     `commcare-core/.../XPathIfFunc`.
//   - `switch(on, cases, fallback)` → expand to a right-nested
//     `if(...)` chain. XPath has no native `switch`, so each case
//     becomes one `if` layer with `<on> = <case.when>` as the
//     condition, the case's `then` as the true branch, and the next
//     case (or the fallback) as the false branch. The expansion shape
//     mirrors what CCHQ authors hand-write today.
//   - `format-date(date, format)` → `format-date(<date>, '<format>')`.
//     CCHQ's `format-date` value function at
//     `commcare-core/src/main/java/org/javarosa/xpath/expr/XPathFormatDateFunc.java`.
//   - `count(via, where?)` → relational join expansion against
//     `instance('casedb')`. The shape mirrors the on-device predicate
//     emitter's `exists` join (without the `> 0` comparator) — `count`
//     is a value, not a presence test, so the bare `count(...)` call
//     surfaces here.
//   - `date-add(value, interval, quantity)` → `date-add(<value>,
//     '<interval>', <quantity>)`. CCHQ wire signature per
//     `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py::date_add`
//     (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`) — three
//     separate arguments, `interval` quoted as a CSQL/XPath string
//     literal. Whether a runtime player dispatches `date-add` is
//     Dimagi's concern; the wire shape is well-formed XPath function-
//     call syntax.
//   - `unwrap-list(value)` → `unwrap-list(<value>)`. CCHQ value
//     function at the `unwrap-list` entry on
//     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
//   - `term(t)` → delegate to the shared on-device term emitter at
//     `../predicate/termEmitter:emitTerm`. The structural lifter for
//     `Term` flavors (property, input, session-user, session-context,
//     literal).

import type {
	Predicate,
	RelationPath,
	SwitchCase,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { emitCaseListFilter } from "../predicate/caseListFilterEmitter";
import { quoteLiteral } from "../predicate/stringQuoting";
import {
	buildAncestorJoinNodeset,
	buildSubcaseJoinNodeset,
	emitTerm,
} from "../predicate/termEmitter";

/**
 * Map a five-op `arith` operator to its XPath wire token. CCHQ's
 * vocabulary (`+`, `-`, `*`, `div`, `mod`) matches XPath 1.0's
 * arithmetic operator set verbatim — `div` and `mod` use the spelled-
 * out forms because XPath's `/` is the path separator and `%` has no
 * XPath meaning. The exhaustive `Record` shape pins the table against
 * the union, so adding an `ArithOp` member surfaces here as a
 * compile-time error.
 */
const ARITH_OPS: Record<
	Extract<ValueExpression, { kind: "arith" }>["op"],
	string
> = {
	"+": "+",
	"-": "-",
	"*": "*",
	div: "div",
	mod: "mod",
};

/**
 * Compile a `ValueExpression` AST to its on-device XPath wire string.
 *
 * The emitter is total — every arm produces a well-formed XPath
 * value expression. Cross-family recursion (`if.cond`,
 * `switch.cases[].when` is a literal, `count.where`) routes the
 * condition through the on-device predicate emitter; intra-family
 * recursion (every other operand) routes through this function.
 */
export function emitOnDeviceExpression(expr: ValueExpression): string {
	switch (expr.kind) {
		case "term":
			// Structural lifter: any `Term` becomes a value via the
			// shared on-device term emitter. Property refs, search-input
			// refs, session refs, and literals all flow through here.
			return emitTerm(expr.term);
		case "today":
			// CCHQ value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `today` entry); also a JavaRosa zero-arg dispatch.
			return "today()";
		case "now":
			// CCHQ value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `now` entry); also a JavaRosa zero-arg dispatch.
			return "now()";
		case "date-coerce":
			// AST `date-coerce(value)` → wire `date(<value>)`. CCHQ
			// registration at the `date` entry on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			return `date(${emitOnDeviceExpression(expr.value)})`;
		case "datetime-coerce":
			// AST `datetime-coerce(value)` → wire `datetime(<value>)`.
			// CCHQ registration at the `datetime` entry on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			return `datetime(${emitOnDeviceExpression(expr.value)})`;
		case "double":
			// CCHQ value function at the `double` entry on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			return `double(${emitOnDeviceExpression(expr.value)})`;
		case "arith":
			// Paren-wrapping is unconditional so a recursive composition
			// stays parse-stable without a precedence walker. The cost
			// is one redundant pair of parens at the outermost level when
			// the expression is the top of a value slot; that's a worth-
			// while trade-off against tracking arithmetic precedence
			// across the recursive walk.
			return `(${emitOnDeviceExpression(expr.left)} ${ARITH_OPS[expr.op]} ${emitOnDeviceExpression(expr.right)})`;
		case "concat":
			// XPath 1.0 standard `concat(...)` is variadic; the schema
			// guarantees at least one part.
			return `concat(${expr.parts.map(emitOnDeviceExpression).join(", ")})`;
		case "coalesce":
			// CCHQ `coalesce(...)` returns the first non-empty argument;
			// the schema guarantees at least one value.
			return `coalesce(${expr.values.map(emitOnDeviceExpression).join(", ")})`;
		case "if":
			// Cross-family recursion: `cond` is a Predicate emitted via
			// the on-device predicate emitter; `then` / `else` recurse
			// through this function. CCHQ wire form for the conditional-
			// dispatch value function.
			return `if(${emitCaseListFilter(expr.cond)}, ${emitOnDeviceExpression(expr.then)}, ${emitOnDeviceExpression(expr.else)})`;
		case "switch":
			// XPath has no native `switch` value function. The expansion
			// is a right-nested `if(...)` chain whose innermost branch is
			// the fallback — a shape CCHQ authors hand-write today.
			return expandSwitchAsIfChain(expr.on, expr.cases, expr.fallback);
		case "format-date":
			// `format-date(<date>, '<pattern>')`. The pattern routes
			// through `quoteLiteral` for the per-dialect single-quote
			// escape (concat-fallback when the pattern contains `'`).
			return `format-date(${emitOnDeviceExpression(expr.date)}, ${quoteLiteral(expr.pattern, "case-list-filter")})`;
		case "count":
			// Relational aggregation. The on-device wire form mirrors
			// the predicate emitter's `exists` join shape — same
			// `instance('casedb')/...` nodeset construction, without
			// the `> 0` comparator that turns `count` into a presence
			// test on the predicate side.
			return emitCount(expr.via, expr.where);
		case "date-add":
			// CCHQ wire signature: `date-add(date, interval, quantity)`
			// — three separate arguments. Source citation:
			// `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py::date_add`
			// (`date-add('2022-01-01', 'days', -1) => '2021-12-31'`).
			// Interval flows through `quoteLiteral` because it is a
			// CSQL/XPath string literal at the wire layer; the schema's
			// `DATE_ADD_INTERVALS` enum already constrains the value
			// space, but routing through the same lexical helper as
			// other string literals keeps the escape rule centralised.
			return `date-add(${emitOnDeviceExpression(expr.date)}, ${quoteLiteral(expr.interval, "case-list-filter")}, ${emitOnDeviceExpression(expr.quantity)})`;
		case "unwrap-list":
			// CCHQ value function at the `unwrap-list` entry on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			return `unwrap-list(${emitOnDeviceExpression(expr.value)})`;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`emitOnDeviceExpression: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Expand a `switch` AST node into a right-nested `if(...)` chain. Each
 * case becomes one `if` layer; the innermost else is the fallback.
 *
 * For `switch(on, [(w1, t1), (w2, t2), ...], fallback)` the expansion
 * is `if(<on> = <w1>, <t1>, if(<on> = <w2>, <t2>, ... <fallback>))`.
 * The discriminator value emits once per case (rather than being
 * captured once and reused) because XPath 1.0 has no `let`-binding
 * mechanism — the recursion textualises the discriminator at every
 * comparison site. The cases are ordered, so the first match's
 * `then` wins.
 *
 * The `when` literal in each case is a `Literal` (per the schema's
 * `switchCaseSchema`), so the comparison routes through the on-device
 * literal-emit shape. The schema rejects empty `cases` lists, so the
 * recursion always has at least one case to peel.
 */
function expandSwitchAsIfChain(
	on: ValueExpression,
	cases: ReadonlyArray<SwitchCase>,
	fallback: ValueExpression,
): string {
	const onText = emitOnDeviceExpression(on);
	// Recurse from the right: the innermost `if` carries the last case
	// and the fallback; each outer layer wraps with the next case.
	let result = emitOnDeviceExpression(fallback);
	for (let i = cases.length - 1; i >= 0; i -= 1) {
		const c = cases[i];
		const whenText = emitOnDeviceExpression({ kind: "term", term: c.when });
		const thenText = emitOnDeviceExpression(c.then);
		result = `if(${onText} = ${whenText}, ${thenText}, ${result})`;
	}
	return result;
}

/**
 * Emit a `count(<nodeset>[<filter>])` call. The nodeset shape mirrors
 * the on-device predicate emitter's `exists` join — same direction-
 * specific anchors, same multi-hop ancestor nesting — and the filter
 * (when present) appends as a bracketed predicate emitted via the on-
 * device predicate emitter.
 *
 * `via.kind === "self"` is the degenerate "no traversal" case. The
 * count over the current case alone is `1` when the filter holds, `0`
 * otherwise; emitting `count()` over a single-element nodeset is not
 * a useful CCHQ wire form, so a self-count expansion uses the
 * conditional-collapse shape `if(<filter>, 1, 0)` (or constant `1`
 * when there's no filter). Authors who want a count over related
 * cases use `ancestorPath` / `subcasePath` / `anyRelationPath`; a
 * `count(self)` reduces predictably and keeps the wire form well-
 * defined.
 *
 * `via.kind === "any-relation"` is direction-agnostic; the count
 * expansion sums the ancestor and subcase counts (`<ancestor> +
 * <subcase>`) to give a single cardinality across both directions.
 */
function emitCount(via: RelationPath, where: Predicate | undefined): string {
	switch (via.kind) {
		case "self":
			if (where === undefined) return "1";
			return `if(${emitCaseListFilter(where)}, 1, 0)`;
		case "ancestor":
			return emitDirectedCount(buildAncestorJoinNodeset(via.via), where);
		case "subcase":
			return emitDirectedCount(buildSubcaseJoinNodeset(via.identifier), where);
		case "any-relation": {
			// Direction-agnostic count: sum the ancestor and subcase
			// cardinalities. Each side computes a directed count
			// independently; their sum is the total reachable count.
			const ancestorCount = emitDirectedCount(
				buildAncestorJoinNodeset([{ identifier: via.identifier }]),
				where,
			);
			const subcaseCount = emitDirectedCount(
				buildSubcaseJoinNodeset(via.identifier),
				where,
			);
			return `(${ancestorCount} + ${subcaseCount})`;
		}
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`emitOnDeviceExpression: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Build a `count(<nodeset>[<filter>])` call for a directed walk. The
 * filter, when present, appends as a bracketed predicate emitted via
 * the on-device predicate emitter. Threading the filter at the build
 * site (rather than string-replacing it after the fact) keeps the
 * wire shape unambiguous when the filter contains `]` characters
 * inside its own subtrees.
 */
function emitDirectedCount(
	nodeset: string,
	where: Predicate | undefined,
): string {
	const filter = where !== undefined ? `[${emitCaseListFilter(where)}]` : "";
	return `count(${nodeset}${filter})`;
}
