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
// Emission policy: total over validator-admitted on-device expressions.
// Every supported `ValueExpression` AST node produces a well-formed XPath
// expression. Calendar-relative `months` / `years`, or a structurally obvious
// datetime base, throw as defensive tripwires: the module validator keeps
// those shapes out of every on-device slot, but this emitter must never
// silently manufacture an unknown call or discard calendar/time semantics
// when invoked outside the normal compile boundary.
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
//   - `date-coerce(value)` AND `datetime-coerce(value)` → `date(<value>)`.
//     This dialect's grammar has exactly one parse-coercion function
//     (`date`, per the arm comment below); its String arm preserves
//     time-of-day, so it IS the datetime coercion here. The AST keeps
//     two kinds because the distinction is real on the evaluators
//     that carry two types — the Postgres arms (`::date` /
//     `::timestamptz`) and server-side CSQL (`date()` / `datetime()`
//     on `XPATH_VALUE_FUNCTIONS`).
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
//   - `date-add(value, interval, quantity)` for seconds through weeks →
//     `date(floor(<value> + <quantity-in-days>))`. JavaRosa registers neither
//     `date-add` nor `datetime-add`, but it does register `floor`; date values
//     numerically coerce to epoch days. Scaling sub-day/week intervals and
//     flooring the final epoch-day value preserves CCHQ date-add's date result
//     for positive, negative, fractional, and pre-epoch values. The validator
//     admits this lowering only for date-typed bases and rejects datetimes
//     (Core's numeric coercion discards their time-of-day) plus calendar-based
//     months/years. The emitter repeats those context-free guards defensively.
//   - `unwrap-list(value)` — rejected defensively. CCHQ recognizes it only
//     while parsing server-side CSQL; CommCare Core does not register an
//     on-device XPath function by that name.
//   - `term(t)` → delegate to the shared on-device term emitter at
//     `../predicate/termEmitter:emitTerm`. The structural lifter for
//     `Term` flavors (property, input, session-user, session-context,
//     literal).

import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import {
	canonicalizeRelationPath,
	type RelationEvaluationScopeContext,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { inferStructuralTemporalType } from "@/lib/domain/predicate/temporalType";
import type {
	Predicate,
	RelationPath,
	SwitchCase,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { emitCaseListFilter } from "../predicate/caseListFilterEmitter";
import {
	descendOnDeviceCaseAnchor,
	emitImmediateRelationPresence,
	type OnDeviceCaseAnchor,
	onDeviceAnchorCaseId,
	ROOT_ON_DEVICE_CASE_ANCHOR,
} from "../predicate/relationPresenceEmitter";
import { quoteLiteral } from "../predicate/stringQuoting";
import {
	buildSubcaseJoinNodeset,
	DEFAULT_INSTANCE_ROOT,
	emitTerm,
	type InstanceRoot,
	type OnDeviceTermEmissionContext,
} from "../predicate/termEmitter";
import { findOnDeviceScalarExpressionIssue } from "./onDeviceCompatibility";

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
 *
 * `root` selects the storage-instance id woven into every relation-
 * walk anchor — `"casedb"` (the default) for the case-loading
 * roster, `"results"` for emission inside a search-target detail
 * block. The parameter threads through every recursive call and
 * cross-family hop so a single authored AST emits consistently
 * against one instance root.
 */
export function emitOnDeviceExpression(
	expr: ValueExpression,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	relationContext: RelationEvaluationScopeContext = {},
	anchor: OnDeviceCaseAnchor = ROOT_ON_DEVICE_CASE_ANCHOR,
	termContext: OnDeviceTermEmissionContext = {},
): string {
	const compatibilityIssue = findOnDeviceScalarExpressionIssue(
		expr,
		relationContext,
	);
	if (compatibilityIssue?.reason === "unwrap-list") {
		throw new Error(
			"emitOnDeviceExpression: unwrap-list is a server-side case-search function and is not registered by CommCare Core's on-device XPath evaluator. Validation should reject it before wire emission.",
		);
	}
	if (compatibilityIssue?.reason === "multi-valued-relation-read") {
		const { property } = compatibilityIssue;
		throw new Error(
			`emitOnDeviceExpression: case property '${property.property}' uses a '${property.via?.kind}' relation that can produce several values in a scalar on-device expression. Use count(...) or put the read inside a predicate relation scope. Validation should reject it before wire emission.`,
		);
	}

	switch (expr.kind) {
		case "term": {
			// Structural lifter: any `Term` becomes a value via the
			// shared on-device term emitter. Property refs, search-input
			// refs, session refs, and literals all flow through here.
			// A related property also materializes every inferable case-type
			// qualifier before emission. Those qualifiers are semantic row-set
			// constraints: another case type may use the same index name, and
			// SQL/Preview already apply the inferred destination filter.
			const value = expr.term;
			if (
				value.kind === "prop" &&
				value.via !== undefined &&
				value.via.kind !== "self"
			) {
				const relation = canonicalizeRelationPath(value.via, {
					...relationContext,
					currentCaseType: relationContext.currentCaseType ?? value.caseType,
				});
				return emitTerm(
					relation.via === value.via ? value : { ...value, via: relation.via },
					root,
					termContext,
					anchor.kind === "root" ? "root" : "related",
				);
			}
			return emitTerm(
				value,
				root,
				termContext,
				anchor.kind === "root" ? "root" : "related",
			);
		}
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
		case "id-of": {
			const xpath = termContext.operationIds?.get(expr.opUuid);
			if (xpath === undefined) {
				throw new Error(
					`emitOnDeviceExpression: operation '${expr.opUuid}' has no case-id XPath binding in this expression context.`,
				);
			}
			return xpath;
		}
		case "acting-user":
			return "/data/meta/userID";
		case "unowned":
			return "'-'";
		case "date-coerce":
		case "datetime-coerce":
			// Both coercions → wire `date(<value>)`. This dialect's
			// grammar (the web-apps evaluator, `commcare-core`'s XPath —
			// `org.javarosa.xpath.parser.ast.ASTNodeFunctionCall`) has
			// one parse-coercion function, `date`
			// (`XPathDateFunc` → `FunctionUtils::toDate`), and no
			// `datetime`; a `datetime(...)` call fails the case list /
			// search session as an unknown function. `date()` is the
			// faithful datetime coercion on this evaluator: its String
			// arm (`DateUtils::parseDateTime`) preserves time-of-day,
			// and the residual date-vs-datetime distinction is
			// unobservable here anyway — comparisons coerce dates to
			// whole days (`XPathCmpExpr` → `FunctionUtils::toNumeric` →
			// `DateUtils::daysSinceEpoch`) and stringification formats
			// date-only (`FunctionUtils::toString` →
			// `DateUtils::formatDate(FORMAT_ISO8601)`).
			return `date(${emitOnDeviceExpression(expr.value, root, relationContext, anchor, termContext)})`;
		case "double":
			// CCHQ value function at the `double` entry on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			return `double(${emitOnDeviceExpression(expr.value, root, relationContext, anchor, termContext)})`;
		case "arith":
			// Paren-wrapping is unconditional so a recursive composition
			// stays parse-stable without a precedence walker. The cost
			// is one redundant pair of parens at the outermost level when
			// the expression is the top of a value slot; that's a worth-
			// while trade-off against tracking arithmetic precedence
			// across the recursive walk.
			return `(${emitOnDeviceExpression(expr.left, root, relationContext, anchor, termContext)} ${ARITH_OPS[expr.op]} ${emitOnDeviceExpression(expr.right, root, relationContext, anchor, termContext)})`;
		case "concat":
			// XPath 1.0 standard `concat(...)` is variadic; the schema
			// guarantees at least one part.
			return `concat(${expr.parts.map((p) => emitOnDeviceExpression(p, root, relationContext, anchor, termContext)).join(", ")})`;
		case "coalesce":
			// CCHQ `coalesce(...)` returns the first non-empty argument;
			// the schema guarantees at least one value.
			return `coalesce(${expr.values.map((v) => emitOnDeviceExpression(v, root, relationContext, anchor, termContext)).join(", ")})`;
		case "if":
			// Cross-family recursion: `cond` is a Predicate emitted via
			// the on-device predicate emitter; `then` / `else` recurse
			// through this function. CCHQ wire form for the conditional-
			// dispatch value function.
			return `if(${emitCaseListFilter(expr.cond, root, relationContext, anchor, termContext)}, ${emitOnDeviceExpression(expr.then, root, relationContext, anchor, termContext)}, ${emitOnDeviceExpression(expr.else, root, relationContext, anchor, termContext)})`;
		case "switch":
			// XPath has no native `switch` value function. The expansion
			// is a right-nested `if(...)` chain whose innermost branch is
			// the fallback — a shape CCHQ authors hand-write today.
			return expandSwitchAsIfChain(
				expr.on,
				expr.cases,
				expr.fallback,
				root,
				relationContext,
				anchor,
				termContext,
			);
		case "format-date":
			// `format-date(<date>, '<pattern>')`. The pattern routes
			// through `quoteLiteral` for the per-dialect single-quote
			// escape (concat-fallback when the pattern contains `'`).
			return `format-date(${emitOnDeviceExpression(expr.date, root, relationContext, anchor, termContext)}, ${quoteLiteral(resolveCommCareDatePattern(expr.pattern), "case-list-filter")})`;
		case "count":
			// Relational aggregation. The on-device wire form mirrors
			// the predicate emitter's `exists` join shape — same
			// `instance('<root>')/...` nodeset construction, without
			// the `> 0` comparator that turns `count` into a presence
			// test on the predicate side.
			return emitCount(
				expr.via,
				expr.where,
				root,
				relationContext,
				anchor,
				termContext,
			);
		case "date-add":
			// JavaRosa's function dispatcher has no `date-add` or
			// `datetime-add` handler. For a date base, Core converts the date to
			// epoch days. Scale every fixed-duration interval into days, floor the
			// result (matching CCHQ's date-only formatting for negative fractions
			// and dates before 1970), then convert it back with `date(...)`.
			// Calendar-relative months/years have no fixed-day equivalent.
			if (expr.interval === "months" || expr.interval === "years") {
				throw new Error(
					`emitOnDeviceExpression: calendar-relative date-add interval '${expr.interval}' cannot run faithfully in JavaRosa's on-device XPath evaluator. Seconds, minutes, hours, days, and weeks can scale to epoch days; validation should reject this expression before wire emission.`,
				);
			}
			if (inferStructuralTemporalType(expr.date) === "datetime") {
				throw new Error(
					"emitOnDeviceExpression: date-add with a structurally datetime-typed base cannot use JavaRosa's epoch-day fallback because it would discard the time-of-day. Validation should reject this expression before wire emission.",
				);
			}
			return `date(floor(${emitOnDeviceExpression(expr.date, root, relationContext, anchor, termContext)} + ${emitDateAddQuantityInDays(expr, root, relationContext, anchor, termContext)}))`;
		case "unwrap-list":
			// Guarded before dispatch. Keep the arm as an explicit tripwire so a
			// future refactor cannot silently reintroduce the unknown Core call.
			throw new Error(
				"emitOnDeviceExpression: unwrap-list cannot run in CommCare Core's on-device XPath evaluator",
			);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`emitOnDeviceExpression: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

function emitDateAddQuantityInDays(
	expression: Extract<ValueExpression, { kind: "date-add" }>,
	root: InstanceRoot,
	relationContext: RelationEvaluationScopeContext,
	anchor: OnDeviceCaseAnchor,
	termContext: OnDeviceTermEmissionContext,
): string {
	const quantity = emitOnDeviceExpression(
		expression.quantity,
		root,
		relationContext,
		anchor,
		termContext,
	);
	switch (expression.interval) {
		case "seconds":
			return `(${quantity} div 86400)`;
		case "minutes":
			return `(${quantity} div 1440)`;
		case "hours":
			return `(${quantity} div 24)`;
		case "days":
			return quantity;
		case "weeks":
			return `(${quantity} * 7)`;
		case "months":
		case "years":
			// Guarded by the caller before recursively emitting either operand.
			throw new Error(
				`emitDateAddQuantityInDays: calendar-relative interval '${expression.interval}' has no fixed day scale`,
			);
		default: {
			const _exhaustive: never = expression.interval;
			return _exhaustive;
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
	root: InstanceRoot,
	relationContext: RelationEvaluationScopeContext,
	anchor: OnDeviceCaseAnchor,
	termContext: OnDeviceTermEmissionContext,
): string {
	const onText = emitOnDeviceExpression(
		on,
		root,
		relationContext,
		anchor,
		termContext,
	);
	// Recurse from the right: the innermost `if` carries the last case
	// and the fallback; each outer layer wraps with the next case.
	let result = emitOnDeviceExpression(
		fallback,
		root,
		relationContext,
		anchor,
		termContext,
	);
	for (let i = cases.length - 1; i >= 0; i -= 1) {
		const c = cases[i];
		const whenText = emitOnDeviceExpression(
			{ kind: "term", term: c.when },
			root,
			relationContext,
			anchor,
			termContext,
		);
		const thenText = emitOnDeviceExpression(
			c.then,
			root,
			relationContext,
			anchor,
			termContext,
		);
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
function emitCount(
	via: RelationPath,
	where: Predicate | undefined,
	root: InstanceRoot,
	relationContext: RelationEvaluationScopeContext,
	anchor: OnDeviceCaseAnchor,
	termContext: OnDeviceTermEmissionContext,
): string {
	const relation = canonicalizeRelationPath(via, relationContext);
	const childContext =
		relation.destinationCaseType === undefined
			? relationContext
			: {
					...relationContext,
					currentCaseType: relation.destinationCaseType,
				};
	const childAnchor = descendOnDeviceCaseAnchor(anchor, relation.via);
	switch (relation.via.kind) {
		case "self":
			if (where === undefined) return "1";
			return `if(${emitCaseListFilter(where, root, childContext, childAnchor, termContext)}, 1, 0)`;
		case "ancestor":
			return `if(${emitImmediateRelationPresence(
				relation.via,
				where === undefined
					? undefined
					: emitCaseListFilter(
							where,
							root,
							childContext,
							childAnchor,
							termContext,
						),
				root,
				anchor.kind === "root" ? termContext.rootCaseId : undefined,
			)}, 1, 0)`;
		case "subcase": {
			const anchorCaseId =
				anchor.kind === "root" && termContext.rootCaseId !== undefined
					? termContext.rootCaseId
					: onDeviceAnchorCaseId(anchor, root);
			if (anchorCaseId === undefined) {
				throw new Error(
					"emitOnDeviceExpression: a child-case count is nested under a relation scope that CommCare Core cannot name. Validation should reject it before wire emission.",
				);
			}
			return emitDirectedCount(
				buildSubcaseJoinNodeset(
					relation.via.identifier,
					root,
					relation.via.ofCaseType,
					anchorCaseId,
				),
				where,
				root,
				childContext,
				childAnchor,
				termContext,
			);
		}
		case "any-relation": {
			// Direction-agnostic count: sum the ancestor and subcase
			// cardinalities. Each side computes a directed count
			// independently; their sum is the total reachable count.
			const ancestorCount = `if(${emitImmediateRelationPresence(
				{
					kind: "ancestor",
					via: [
						{
							identifier: relation.via.identifier,
							throughCaseType: relation.via.ofCaseType,
						},
					],
				},
				where === undefined
					? undefined
					: emitCaseListFilter(
							where,
							root,
							childContext,
							descendOnDeviceCaseAnchor(anchor, {
								kind: "ancestor",
								via: [
									{
										identifier: relation.via.identifier,
										throughCaseType: relation.via.ofCaseType,
									},
								],
							}),
							termContext,
						),
				root,
				anchor.kind === "root" ? termContext.rootCaseId : undefined,
			)}, 1, 0)`;
			const anchorCaseId =
				anchor.kind === "root" && termContext.rootCaseId !== undefined
					? termContext.rootCaseId
					: onDeviceAnchorCaseId(anchor, root);
			if (anchorCaseId === undefined) {
				throw new Error(
					"emitOnDeviceExpression: an any-relation count is nested under a relation scope that CommCare Core cannot name. Validation should reject it before wire emission.",
				);
			}
			const subcaseCount = emitDirectedCount(
				buildSubcaseJoinNodeset(
					relation.via.identifier,
					root,
					relation.via.ofCaseType,
					anchorCaseId,
				),
				where,
				root,
				childContext,
				{ kind: "unaddressable" },
				termContext,
			);
			return `(${ancestorCount} + ${subcaseCount})`;
		}
		default: {
			const _exhaustive: never = relation.via;
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
	root: InstanceRoot,
	relationContext: RelationEvaluationScopeContext,
	anchor: OnDeviceCaseAnchor,
	termContext: OnDeviceTermEmissionContext,
): string {
	const filter =
		where !== undefined
			? `[${emitCaseListFilter(where, root, relationContext, anchor, termContext)}]`
			: "";
	return `count(${nodeset}${filter})`;
}
