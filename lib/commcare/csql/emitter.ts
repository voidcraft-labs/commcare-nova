/**
 * The CSQL emitter: one function of (arm, position) that builds the CSQL
 * tree of one `_xpath_query` clause (`tree.ts`), which `print.ts` prints.
 *
 * CSQL is the server-side query language CommCare HQ's case search compiles
 * to Elasticsearch when a remote request fires
 * (`commcare-hq/docs/case_search_query_language.rst`;
 * `corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`). Each node's
 * position (`positions.ts`) decides its emission:
 *
 * - `query`: HQ's query forms (comparisons, `and`/`or`/`not`, the query
 *   functions), or, for a clause that reads no case row, a choice the device
 *   makes between `match-all()` and `match-none()`;
 * - `anchor`: the case property, `@case_type` or `subcase-count(…)` a
 *   comparison tests;
 * - `server-value`: literals and HQ's value functions, which HQ evaluates;
 * - `raw`: literals HQ reads as written;
 * - `runtime`: a hole holding the subtree's on-device wire tree
 *   (`xpath/wire/fromExpression.ts::toWire`), which Core evaluates inside the
 *   `_xpath_query` concat. No on-device wrapper or lowering ever enters CSQL
 *   text: HQ compares instants itself.
 *
 * Runtime values never become sibling `<data>` slots: Core threads only
 * `<prompt>` values into `instance('search-input:results')`
 * (`RemoteQuerySessionManager.initUserAnswers`), and HQ reads any other key
 * as a case-property filter (`case_search/utils.py::_apply_filter`), so the
 * value is spliced into the query text, HQ's documented pattern
 * (`case_search_query_language.rst::"Example Query + Tips"`).
 */

import {
	expressionChildPath,
	expressionChildren,
} from "@/lib/domain/expression/children";
import { choiceValue } from "@/lib/domain/expression/choiceValue";
import { activeRowScope } from "@/lib/domain/expression/context";
import {
	type CsqlPositionMap,
	csqlPositionKey,
	csqlPositions,
	isCsqlServerValueFunction,
	readsSearchRow,
} from "@/lib/domain/expression/csqlPositions";
import { DISTANCE_UNITS } from "@/lib/domain/expression/distance";
import {
	isValidStaticGeopointCenter,
	normalizeStaticGeopoint,
} from "@/lib/domain/expression/geopoint";
import { normalizeRelationEvaluationScopes } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { normalizeRelationPropertyReads } from "@/lib/domain/expression/normalizeRelationReads";
import { formatNumeric } from "@/lib/domain/expression/numberLiteral";
import { asTemporalType } from "@/lib/domain/expression/temporalType";
import {
	expressionChildContext,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	ComparisonKind,
	Expression,
	Literal,
	RelationStep,
	Term,
} from "@/lib/domain/expression/types";
import { SYSTEM_DATETIME_CASE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import type { Uuid } from "@/lib/domain/uuid";
import { emitCasePropertyWirePath } from "../casePropertyWire";
import { w } from "../xpath/wire/builders";
import { toWire, type WireBuildContext } from "../xpath/wire/fromExpression";
import { normalizeGeopoint, validGeopointCenter } from "../xpath/wire/geopoint";
import {
	STANDALONE_SEARCH_INPUT_INSTANCE_ID,
	searchInputInstance,
} from "../xpath/wire/instances";
import type { WireExpr } from "../xpath/wire/tree";
import { materializeCsqlChoices } from "./choices";
import { type CsqlEmissionResult, csqlClauseWrapper } from "./print";
import { normalizeCsqlPredicate } from "./representability";
import {
	blankComparandGuard,
	needsBlankComparandGuard,
} from "./runtimeCsqlDateSafety";
import {
	classifyCalendarDateAddQuantity,
	classifySubcaseCountBound,
	invalidNonnegativeWholeNumberXPath,
	invalidWholeNumberXPath,
} from "./runtimeCsqlNumericSafety";
import { collectRuntimeCsqlStringExpressionInputNames } from "./runtimeCsqlQuoteSafety";
import { CSQL_LIST_ITEM_UNSAFE_PATTERN } from "./segment";
import {
	type CsqlComparison,
	type CsqlNode,
	type CsqlObligation,
	type CsqlQueryFunction,
	type CsqlRuntimeHole,
	c,
} from "./tree";

export type { CsqlEmissionResult } from "./print";

/** The wire build context of a CSQL emission, its target fixed to the
 * runtime segment's (`csql-runtime`). */
export type CsqlEmissionContext = Omit<WireBuildContext, "target">;

/**
 * The CSQL functions that read related cases, each of which HQ's case search
 * refuses without `CASE_SEARCH_RELATED_LOOKUPS`
 * (`case_search/filter_dsl.py::build_filter_from_ast` sends `subcase-exists`,
 * `subcase-count` and `ancestor-exists` to `_require_related_lookups_flag`).
 */
export type CsqlRelatedCaseQuery =
	| "ancestor-exists"
	| "subcase-exists"
	| "subcase-count";

/**
 * The open `collectRelatedCaseQueries` scope, if any. Emission is synchronous,
 * so the scope a write lands in is the one that opened around it.
 */
let relatedCaseQueriesWritten: Set<CsqlRelatedCaseQuery> | undefined;

/** Every site that writes a related-case function into CSQL names it here. */
function writeRelatedCaseQuery(name: CsqlRelatedCaseQuery): void {
	relatedCaseQueriesWritten?.add(name);
}

/**
 * Run `emit` and report each related-case function the CSQL emitter wrote
 * during it. The answer is the emitter's own: the sites that write
 * `ancestor-exists(...)`, `subcase-exists(...)` or `subcase-count(...)` into
 * a query record the call as they write it, so an ancestor case-id comparison
 * written as `ancestor-exists` counts, its flag-free spelling
 * `parent/@case_id = v` does not, and a `count` the emitter inlines as an
 * on-device number does not.
 */
export function collectRelatedCaseQueries<T>(emit: () => T): {
	readonly result: T;
	readonly written: ReadonlySet<CsqlRelatedCaseQuery>;
} {
	const outer = relatedCaseQueriesWritten;
	const written = new Set<CsqlRelatedCaseQuery>();
	relatedCaseQueriesWritten = written;
	try {
		const result = emit();
		for (const name of written) outer?.add(name);
		return { result, written };
	} finally {
		relatedCaseQueriesWritten = outer;
	}
}

/**
 * The clause as the emitter reads it: choices materialized to their wire
 * tokens, a query anchor authored on the right put on the left, and every
 * related read inside its relation's own scope. The segment keys of the
 * emitted tree are checker paths in this expression, so Preview's fold
 * prepares a clause the same way before it substitutes.
 */
export function prepareCsqlClause(
	predicate: Expression,
	context: CsqlEmissionContext,
): Expression {
	const row = activeRowScope(context.types);
	const currentCaseType =
		row?.kind === "case"
			? row.caseType
			: row?.kind === "table"
				? row.capturedCase?.caseType
				: undefined;
	const relationContext = {
		caseTypes: context.types.facts.caseTypes,
		currentCaseType,
	};
	const normalized = normalizeRelationEvaluationScopes(
		normalizeCsqlPredicate(materializeCsqlChoices(predicate, context.types)),
		relationContext,
	);
	// The shared evaluation-scope pass gives every dialect the same row
	// semantics. This lift stays as the grammar adapter that puts a related
	// read HQ's search tests into its `exists` envelope.
	return normalizeRelationPropertyReads(normalized, {
		...relationContext,
		unsupportedPropertyOperands: "throw",
	});
}

/** The CSQL tree of one clause. */
export function emitCsqlTree(
	predicate: Expression,
	context: CsqlEmissionContext,
): CsqlNode {
	const prepared = prepareCsqlClause(predicate, context);
	return query(prepared, [], {
		...context,
		positions: csqlPositions(prepared),
	});
}

/** One `_xpath_query` value: the wrapper and its obligations. */
export function emitCsql(
	predicate: Expression,
	context: CsqlEmissionContext,
): CsqlEmissionResult {
	return csqlClauseWrapper(emitCsqlTree(predicate, context));
}

interface Emission extends CsqlEmissionContext {
	readonly positions: CsqlPositionMap;
}

const COMPARISON_OPS: Readonly<Record<ComparisonKind, CsqlComparison>> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

function operandPath(
	parent: Expression,
	slot: string,
	path: CheckPath,
): CheckPath {
	return expressionChildPath(parent.kind, { kind: "operand", slot }, path);
}

function itemPath(
	parent: Expression,
	slot: string,
	index: number,
	path: CheckPath,
): CheckPath {
	return expressionChildPath(parent.kind, { kind: "item", slot, index }, path);
}

function positionAt(emission: Emission, path: CheckPath) {
	return emission.positions.get(csqlPositionKey(path));
}

/** The context the checker gives `parent`'s operand `slot`. */
function childEmission(
	parent: Expression,
	slot: string,
	emission: Emission,
): Emission {
	const child = expressionChildren(parent).find(
		(entry) => entry.role.kind === "operand" && entry.role.slot === slot,
	);
	return child === undefined
		? emission
		: {
				...emission,
				types: expressionChildContext(parent, child, emission.types),
			};
}

function runtimeWire(expression: Expression, emission: Emission): WireExpr {
	if (expression.kind === "term" && expression.term.kind === "input")
		return searchInputRead(expression.term.searchInputUuid, emission);
	const { positions: _positions, ...context } = emission;
	return toWire(expression, { ...context, target: "csql-runtime" });
}

/** A search answer as Core reads it while building the request. */
function searchInputRead(uuid: Uuid, emission: Emission): WireExpr {
	return w.instance(
		searchInputInstance(
			emission.bindings?.searchInputInstanceId ??
				STANDALONE_SEARCH_INPUT_INSTANCE_ID,
		),
		[
			w.step("input"),
			w.step("field", [
				w.eq(w.context([w.attr("name")]), w.str(inputName(uuid, emission))),
			]),
		],
	);
}

function searchInputs(emission: Emission) {
	return emission.types.profile.searchInputs;
}

function inputName(uuid: Uuid, emission: Emission): string {
	const name =
		emission.bindings?.searchInputNames?.get(uuid) ??
		searchInputs(emission).find((input) => input.uuid === uuid)?.name;
	if (name === undefined)
		throw new Error(
			`Search input identity '${uuid}' has no current runtime-name binding.`,
		);
	return name;
}

/** The prompts whose bytes can reach a value the device works out. */
function blamedInputs(
	expression: Expression,
	emission: Emission,
): readonly string[] {
	return [
		...collectRuntimeCsqlStringExpressionInputNames(
			expression,
			searchInputs(emission),
		),
	].sort();
}

// ── query position ───────────────────────────────────────────────────────

function query(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (positionAt(emission, path) === "runtime")
		return runtimeClause(expression, path, emission);
	switch (expression.kind) {
		case "match-all":
		case "match-none":
			return c.query(expression.kind);
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return comparison(expression, path, emission);
		case "and":
		case "or":
			return c.join(
				expression.kind,
				expression.clauses.map((clause, index) =>
					query(clause, itemPath(expression, "clauses", index, path), emission),
				),
			);
		case "not":
			return c.not(
				query(
					expression.clause,
					operandPath(expression, "clause", path),
					emission,
				),
			);
		case "in":
			return membership(expression, path, emission);
		case "between":
			return range(expression, path, emission);
		case "is-blank":
			if (
				expression.left.kind === "term" &&
				expression.left.term.kind === "literal"
			)
				return c.query(
					expression.left.term.value === null ||
						expression.left.term.value === ""
						? "match-all"
						: "match-none",
				);
			// `<p> = ''`: HQ's `case_property_query` reads `''` as missing
			// (`corehq/apps/es/case_search.py::case_property_query`), matching an
			// absent, cleared or empty value alike.
			return c.cmp(
				"=",
				anchor(
					expression.left,
					operandPath(expression, "left", path),
					emission,
				),
				c.literal(""),
			);
		case "matches-pattern":
			throw new Error(
				"csqlEmitter: 'matches-pattern' has no server-side search form; the type checker admits it only in a Search field's required condition or check.",
			);
		case "match":
			return textMatch(expression, path, emission);
		case "multi-select-contains":
			return selection(expression, path, emission);
		case "within-distance":
			return distance(expression, path, emission);
		case "exists":
		case "missing":
			return relation(expression, path, emission);
		case "when-input-present":
			return c.presence(
				csqlPositionKey(path),
				runtimeWire({ kind: "term", term: expression.input }, emission),
				query(
					expression.clause,
					operandPath(expression, "clause", path),
					emission,
				),
			);
		case "if":
			return conditionChoice(expression, path, emission);
		case "switch":
			return switchChoice(expression, path, emission);
		default:
			throw new Error(
				`csqlEmitter: '${expression.kind}' is unavailable as a native search clause.`,
			);
	}
}

/** A clause that reads no case row: the device decides it, and HQ reads
 * `match-all()` or `match-none()`. */
function runtimeClause(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	return c.choice(
		csqlPositionKey(path),
		runtimeWire(expression, emission),
		c.query("match-all"),
		c.query("match-none"),
	);
}

/**
 * An `if` between clauses. A condition that reads no row is the device's
 * choice of clause; one that reads the row is HQ's own
 * `((c) and (A)) or (not(c) and (B))`.
 */
function conditionChoice(
	expression: Extract<Expression, { kind: "if" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const condPath = operandPath(expression, "cond", path);
	const thenNode = query(
		expression.then,
		operandPath(expression, "then", path),
		emission,
	);
	const elseNode = query(
		expression.else,
		operandPath(expression, "else", path),
		emission,
	);
	if (positionAt(emission, condPath) === "runtime")
		return c.choice(
			csqlPositionKey(path),
			runtimeWire(expression.cond, emission),
			thenNode,
			elseNode,
		);
	const condition = query(expression.cond, condPath, emission);
	return c.or(
		c.group(c.and(c.group(condition), c.group(thenNode))),
		c.group(c.and(c.not(condition), c.group(elseNode))),
	);
}

/**
 * A `switch` between clauses, case by case. A selector that reads no row is
 * the device's choice; one that reads the row is HQ's own, each case
 * `((on = when) and (then)) or (not(on = when) and (<the cases after>))`, as
 * a row-reading `if` is.
 */
function switchChoice(
	expression: Extract<Expression, { kind: "switch" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const onPath = operandPath(expression, "on", path);
	const native = positionAt(emission, onPath) !== "runtime";
	let result = query(
		expression.fallback,
		operandPath(expression, "fallback", path),
		emission,
	);
	for (let index = expression.cases.length - 1; index >= 0; index--) {
		const entry = expression.cases[index];
		if (entry === undefined) continue;
		const whenPath = expressionChildPath(
			"switch",
			{ kind: "switch-case", index, slot: "when" },
			path,
		);
		const thenPath = expressionChildPath(
			"switch",
			{ kind: "switch-case", index, slot: "then" },
			path,
		);
		const thenNode = query(entry.then, thenPath, emission);
		if (native) {
			const condition = compare(
				"eq",
				{ expression: expression.on, path: onPath },
				{ expression: { kind: "term", term: entry.when }, path: whenPath },
				emission,
			);
			result = c.or(
				c.group(c.and(c.group(condition), c.group(thenNode))),
				c.group(c.and(c.not(condition), c.group(result))),
			);
			continue;
		}
		result = c.choice(
			csqlPositionKey(whenPath),
			runtimeWire(
				{
					kind: "eq",
					left: expression.on,
					right: { kind: "term", term: entry.when },
				},
				emission,
			),
			thenNode,
			result,
		);
	}
	return result;
}

function comparison(
	expression: Extract<Expression, { kind: ComparisonKind }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	return compare(
		expression.kind,
		{
			expression: expression.left,
			path: operandPath(expression, "left", path),
		},
		{
			expression: expression.right,
			path: operandPath(expression, "right", path),
		},
		emission,
	);
}

/** A comparison of a query side and a value, each at its own path. */
function compare(
	kind: ComparisonKind,
	anchorSide: { readonly expression: Expression; readonly path: CheckPath },
	valueSide: { readonly expression: Expression; readonly path: CheckPath },
	emission: Emission,
): CsqlNode {
	const left = anchor(anchorSide.expression, anchorSide.path, emission);
	const right = isSubcaseCount(anchorSide.expression)
		? subcaseCountBound(valueSide.expression, valueSide.path, emission)
		: value(valueSide.expression, valueSide.path, emission);
	if (
		(kind === "eq" || kind === "neq") &&
		readsInstantByRange(anchorSide.expression, emission)
	) {
		const equal = instantEquality(left, right);
		return guardBlank(kind === "eq" ? c.group(equal) : c.not(equal), true, [
			right,
		]);
	}
	return guardBlank(
		c.cmp(COMPARISON_OPS[kind], left, right),
		needsBlankComparandGuard(anchorSide.expression, kind),
		[right],
	);
}

/**
 * Whether an equality on `anchor` is the closed instant range
 * (06-csql.md §3.13, finding 75): HQ answers `=` on a custom property by text
 * equality on its stored spelling (`es/case_search.py::case_property_query`)
 * and on a system date by a raw Elasticsearch term, but an ordering by instant
 * (`comparison.py::case_property_range_query`, `_create_system_datetime_query`),
 * so `(p >= v and p <= v)` finds every spelling of the instant
 * (CI run 39315022018). A custom date-and-time property takes it in every
 * CSQL slot; `date_opened`, `last_modified` and `closed_on` only where no
 * device evaluates the slot, since the checker refuses their equality with a
 * date and time anywhere a device does (the day rule).
 */
function readsInstantByRange(anchor: Expression, emission: Emission): boolean {
	if (anchor.kind !== "term" || anchor.term.kind !== "prop") return false;
	if (scalarDataType(typeOf(anchor, emission.types)?.data) !== "datetime")
		return false;
	if (!SYSTEM_DATETIME_CASE_PROPERTIES.has(anchor.term.property)) return true;
	const targets = emission.types.profile.targets;
	return !targets.has("SU") && !targets.has("XF");
}

/** `p >= v and p <= v`: `v` printed twice by the ordinary value rules. */
function instantEquality(anchor: CsqlNode, value: CsqlNode): CsqlNode {
	return c.and(c.cmp(">=", anchor, value), c.cmp("<=", anchor, value));
}

function guardBlank(
	node: CsqlNode,
	needed: boolean,
	values: readonly CsqlNode[],
): CsqlNode {
	if (!needed) return node;
	const guard = blankComparandGuard(values);
	return guard === undefined ? node : c.guarded(node, guard);
}

/**
 * `in` as an `or` of equalities, not `selected-any`: HQ's `selected-any`
 * splits its value on whitespace (`corehq/apps/es/case_search.py::case_property_text_query`),
 * which would break a value with a space.
 */
function membership(
	expression: Extract<Expression, { kind: "in" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const left = anchor(
		expression.left,
		operandPath(expression, "left", path),
		emission,
	);
	const ranged = readsInstantByRange(expression.left, emission);
	const equalities = expression.values.map((entry, index) => {
		const entryPath = itemPath(expression, "values", index, path);
		const entryExpression: Expression = { kind: "term", term: entry };
		const entryValue = isSubcaseCount(expression.left)
			? subcaseCountBound(entryExpression, entryPath, emission)
			: value(entryExpression, entryPath, emission);
		return ranged
			? c.group(instantEquality(left, entryValue))
			: c.cmp("=", left, entryValue);
	});
	const [only] = equalities;
	return equalities.length === 1 && only !== undefined
		? only
		: c.group(c.join("or", equalities));
}

/** `between` as HQ's two orderings, kept whole under any parent. */
function range(
	expression: Extract<Expression, { kind: "between" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const left = anchor(
		expression.left,
		operandPath(expression, "left", path),
		emission,
	);
	const bound = (slot: "lower" | "upper") => {
		const bound = expression[slot];
		if (bound === undefined) return undefined;
		const boundPath = operandPath(expression, slot, path);
		return isSubcaseCount(expression.left)
			? subcaseCountBound(bound, boundPath, emission)
			: value(bound, boundPath, emission);
	};
	const lower = bound("lower");
	const upper = bound("upper");
	const comparisons = [
		...(lower === undefined
			? []
			: [c.cmp(expression.lowerInclusive ? ">=" : ">", left, lower)]),
		...(upper === undefined
			? []
			: [c.cmp(expression.upperInclusive ? "<=" : "<", left, upper)]),
	];
	if (comparisons.length === 0)
		throw new Error(
			"csqlEmitter: a 'between' reached emission with neither bound. The between schema rejects this shape when it is authored, so the expression was built past validation.",
		);
	const [only] = comparisons;
	const node =
		comparisons.length === 1 && only !== undefined
			? only
			: c.group(c.join("and", comparisons));
	// A range is two orderings, so a blank runtime bound is guarded on any
	// property (`runtimeCsqlDateSafety.ts`).
	return guardBlank(node, needsBlankComparandGuard(expression.left, "gte"), [
		...(lower === undefined ? [] : [lower]),
		...(upper === undefined ? [] : [upper]),
	]);
}

const MATCH_FUNCTIONS: Readonly<
	Record<Extract<Expression, { kind: "match" }>["mode"], CsqlQueryFunction>
> = {
	fuzzy: "fuzzy-match",
	phonetic: "phonetic-match",
	"fuzzy-date": "fuzzy-date",
	"starts-with": "starts-with",
};

/** A text match (`query_functions.py::fuzzy_match`, `::phonetic_match`,
 * `::fuzzy_date`, `::starts_with`). */
function textMatch(
	expression: Extract<Expression, { kind: "match" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (expression.property.kind !== "prop")
		throw new Error(
			"csqlEmitter: a text match needs a case property in a server search.",
		);
	const valuePath = operandPath(expression, "value", path);
	const node = value(expression.value, valuePath, emission);
	return c.query(MATCH_FUNCTIONS[expression.mode], [
		propertyStep(expression.property.property),
		groupedValueFunction(expression.value, valuePath, emission, node),
	]);
}

/**
 * HQ's lexer (eulxml) leaves COMMA out of its operator forcers, so a function
 * right after a comma reads as a path name. A value function in an argument
 * after the first is grouped; the parenthesis restores the call.
 */
function groupedValueFunction(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
	node: CsqlNode,
): CsqlNode {
	return positionAt(emission, path) !== "runtime" &&
		isCsqlServerValueFunction(expression)
		? c.group(node)
		: node;
}

/**
 * `multi-select-contains`. A fixed value is one choice, `selected(p, 'v')`.
 * A value the device works out is a space-separated list of choices, sent
 * as `selected-any`/`selected-all`, which HQ answers by an analysed match on
 * its tokens (`query_functions.py::_selected_query`); a blank one is guarded,
 * since HQ reads `''` as "is blank".
 *
 * A fixed value matches one way on both runtimes only while it is one token:
 * HQ matches any word of it, Core's `selected` the exact space-bounded value
 * (`XPathSelectedFunc.java::multiSelected`). `matchModeWhitespaceInValue`
 * refuses the shapes that differ.
 */
function selection(
	expression: Extract<Expression, { kind: "multi-select-contains" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (expression.property.kind !== "prop")
		throw new Error(
			"csqlEmitter: a selection test needs a case property in a server search.",
		);
	const property = propertyStep(expression.property.property);
	const calls = expression.values.map((entry, index) => {
		const entryPath = itemPath(expression, "values", index, path);
		if (entry.kind === "literal" || entry.kind === "choice")
			return c.query("selected", [
				property,
				c.literal(
					entry.kind === "literal"
						? stringifyLiteral(entry.value)
						: choiceValue(entry, emission.types.facts.options),
				),
			]);
		const hole = runtimeHole(entry, entryPath, emission);
		return guardBlank(
			c.query(
				expression.quantifier === "any" ? "selected-any" : "selected-all",
				[property, c.runtime(hole)],
			),
			true,
			[c.runtime(hole)],
		);
	});
	const [only] = calls;
	return calls.length === 1 && only !== undefined
		? only
		: c.group(c.join(expression.quantifier === "any" ? "or" : "and", calls));
}

/** `selected*` reads its value as text; a number or boolean is its
 * CommCare spelling and a null the empty string. */
function stringifyLiteral(value: Literal["value"]): string {
	if (value === null) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return formatNumeric(value);
	return value;
}

/**
 * `within-distance(p, '<lat lon>', <distance>, '<unit>')`
 * (`query_functions.py::within_distance`). HQ reads the center, distance and
 * unit as written. A runtime center is normalised on the device and held to
 * a geopoint; a runtime radius and unit sit between fixed double quotes,
 * held to a positive number and to one of HQ's nine units
 * (`es/queries.py::DISTANCE_UNITS`), which also prove them quote-free.
 */
function distance(
	expression: Extract<Expression, { kind: "within-distance" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const centerPath = operandPath(expression, "center", path);
	return c.query("within-distance", [
		propertyStep(expression.property.property),
		geopointCenter(expression.center, centerPath, emission),
		typeof expression.distance === "number"
			? c.number(expression.distance)
			: obligedQuoteFree(
					expression.distance,
					operandPath(expression, "distance", path),
					emission,
					(read) => ({
						condition: w.not(w.gt(w.call("number", [read]), w.num(0))),
						kind: "positive-number",
					}),
				),
		typeof expression.unit === "string"
			? c.literal(expression.unit)
			: obligedQuoteFree(
					expression.unit,
					operandPath(expression, "unit", path),
					emission,
					(read) => ({
						condition: w.not(
							w.or(...DISTANCE_UNITS.map((unit) => w.eq(read, w.str(unit)))),
						),
						kind: "distance-unit",
					}),
				),
	]);
}

function obligedQuoteFree(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
	obligation: (read: WireExpr) => Omit<CsqlObligation, "inputNames">,
): CsqlNode {
	const read = runtimeWire(expression, emission);
	const names = holeInputNames(expression, emission);
	return c.runtime({
		key: csqlPositionKey(path),
		value: read,
		quoting: "quote-free",
		obligation: {
			...obligation(read),
			...(names === undefined ? {} : { inputNames: names }),
		},
	});
}

/**
 * HQ's `GeoPoint.from_string(..., flexible=True)` reads two or four
 * space-separated numbers. A fixed center is normalised here; a runtime one
 * on the device, before it is spliced in.
 */
function geopointCenter(
	center: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (
		center.kind === "term" &&
		center.term.kind === "literal" &&
		typeof center.term.value === "string"
	) {
		if (!isValidStaticGeopointCenter(center.term.value))
			throw new Error(
				"emitCsql: within-distance has an invalid literal center. Use latitude and longitude (optionally altitude and accuracy) with valid coordinate ranges; validation should reject this before wire emission.",
			);
		return c.literal(normalizeStaticGeopoint(center.term.value));
	}
	const raw = runtimeWire(center, emission);
	const normalized = normalizeGeopoint(raw);
	const inputNames = [...collectGeopointCenterInputNames(center)]
		.map(
			(uuid) =>
				searchInputs(emission).find((input) => input.uuid === uuid)?.name,
		)
		.filter((name): name is string => name !== undefined)
		.sort();
	return c.runtime({
		key: csqlPositionKey(path),
		value: raw,
		quoting: "bare",
		// Valid geopoint text holds no quote, so a fixed delimiter is safe; the
		// geopoint obligation subsumes the quote one.
		print: w.call("concat", [w.str('"'), normalized, w.str('"')]),
		obligation: {
			condition: w.not(validGeopointCenter(raw, normalized)),
			kind: "geopoint",
			inputNames,
		},
	});
}

/**
 * `exists` and `missing`, by direction: `ancestor-exists(<path>, <filter>)`
 * (`ancestor_functions.py::ancestor_exists`, whose path is a bare `Step` or
 * `Step / Step`: a string literal finds nothing), `subcase-exists('<id>',
 * <filter>)` (`subcase_functions.py::_extract_subcase_query_parts`, whose
 * identifier is a string), and for `any-relation` both, or-ed.
 */
function relation(
	expression: Extract<Expression, { kind: "exists" | "missing" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const via = expression.via;
	const wherePath = operandPath(expression, "where", path);
	const whereEmission = childEmission(expression, "where", emission);
	const filter = () =>
		expression.where === undefined
			? c.query("match-all")
			: query(expression.where, wherePath, whereEmission);
	let node: CsqlNode;
	switch (via.kind) {
		case "self":
			throw new Error(
				"csqlEmitter: an 'exists' or 'missing' over 'this case' reached CSQL emission, which has no form for it. The case-list validator refuses this relationship when it is authored.",
			);
		case "ancestor":
			node =
				(expression.kind === "exists" &&
					flagFreeAncestorCaseId(
						via.via,
						expression.where,
						wherePath,
						whereEmission,
					)) ||
				ancestorExists(via.via, filter);
			break;
		case "subcase":
			node = subcaseExists(
				via.identifier,
				via.ofCaseType,
				expression.where === undefined,
				filter,
			);
			break;
		case "any-relation":
			node = c.group(
				c.or(
					ancestorExists(
						[{ identifier: via.identifier, throughCaseType: via.ofCaseType }],
						filter,
					),
					subcaseExists(
						via.identifier,
						via.ofCaseType,
						expression.where === undefined,
						filter,
					),
				),
			);
			break;
	}
	return expression.kind === "missing" ? c.not(node) : node;
}

function ancestorExists(
	steps: readonly RelationStep[],
	filter: () => CsqlNode,
): CsqlNode {
	writeRelatedCaseQuery("ancestor-exists");
	// A slash-joined path constrains only the last ancestor, so a chain with a
	// case-type qualifier is one call per hop, every type check kept, as
	// Preview's per-hop filters keep it.
	if (steps.some((step) => step.throughCaseType !== undefined))
		return qualifiedAncestorChain(steps, 0, filter);
	return c.query("ancestor-exists", [
		c.step(...steps.map((step) => step.identifier)),
		c.group(filter()),
	]);
}

function qualifiedAncestorChain(
	steps: readonly RelationStep[],
	index: number,
	filter: () => CsqlNode,
): CsqlNode {
	writeRelatedCaseQuery("ancestor-exists");
	const step = steps[index];
	if (step === undefined)
		throw new Error("csqlEmitter: an ancestor path ran out of steps.");
	const inner =
		index === steps.length - 1
			? filter()
			: qualifiedAncestorChain(steps, index + 1, filter);
	return c.query("ancestor-exists", [
		c.step(step.identifier),
		c.group(withCaseType(step.throughCaseType, inner)),
	]);
}

function subcaseExists(
	identifier: string,
	ofCaseType: string | undefined,
	unfiltered: boolean,
	filter: () => CsqlNode,
): CsqlNode {
	writeRelatedCaseQuery("subcase-exists");
	if (unfiltered && ofCaseType === undefined)
		return c.query("subcase-exists", [c.literal(identifier)]);
	return c.query("subcase-exists", [
		c.literal(identifier),
		c.group(withCaseType(ofCaseType, filter())),
	]);
}

function withCaseType(
	caseType: string | undefined,
	filter: CsqlNode,
): CsqlNode {
	return caseType === undefined
		? filter
		: c.and(
				c.cmp("=", c.step("@case_type"), c.literal(caseType)),
				c.group(filter),
			);
}

/**
 * HQ's flag-free ancestor comparison, `<path>/@case_id = <v>`
 * (`filter_dsl.py::build_filter_from_ast` admits an ancestor comparison whose
 * last step is `@case_id` without `CASE_SEARCH_RELATED_LOOKUPS`, and
 * `ancestor_functions.py::_get_case_ids_from_ast_filter` reads the ids from
 * the right side with no index query). Written for an
 * `exists(ancestor …, where: eq(case_id, v))` whose `v` HQ is given as a
 * value and is a case id of a known type that every step's qualifier names
 * (or no step has one), so the qualifier the normalizer inferred adds
 * nothing. A literal id keeps `ancestor-exists`, where the qualifier filters;
 * so does `!=`, which HQ answers with an unbounded index query.
 */
function flagFreeAncestorCaseId(
	steps: readonly RelationStep[],
	where: Expression | undefined,
	wherePath: CheckPath,
	emission: Emission,
): CsqlNode | undefined {
	if (where?.kind !== "eq") return undefined;
	const { left, right } = where;
	if (
		left.kind !== "term" ||
		left.term.kind !== "prop" ||
		left.term.property !== "case_id" ||
		(left.term.via !== undefined && left.term.via.kind !== "self")
	)
		return undefined;
	// A literal keeps the qualifier's filter; a row read has no row to read
	// where HQ evaluates the value.
	if (right.kind === "term" && right.term.kind === "literal") return undefined;
	if (readsSearchRow(right)) return undefined;
	const rightPath = operandPath(where, "right", wherePath);
	const position = positionAt(emission, rightPath);
	if (position !== "runtime" && position !== "server-value") return undefined;
	const caseType = typeOf(right, emission.types)?.caseIdOf;
	if (caseType === undefined) return undefined;
	if (
		steps.some(
			(step) =>
				step.throughCaseType !== undefined && step.throughCaseType !== caseType,
		)
	)
		return undefined;
	return c.cmp(
		"=",
		c.step(...steps.map((step) => step.identifier), "@case_id"),
		value(right, rightPath, emission),
	);
}

// ── anchors ──────────────────────────────────────────────────────────────

function propertyStep(property: string): CsqlNode {
	// Case attributes (`case_id`, `case_type`, `owner_id`, `status`) take
	// their `@` (`case_search/const.py::INDEXED_METADATA_BY_KEY`).
	return c.step(emitCasePropertyWirePath(property));
}

function isSubcaseCount(expression: Expression): boolean {
	return (
		expression.kind === "count" &&
		"kind" in expression.via &&
		expression.via.kind === "subcase"
	);
}

function anchor(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (expression.kind === "term") {
		if (expression.term.kind === "prop")
			return propertyStep(expression.term.property);
		if (expression.term.kind === "case-row-type") return c.step("@case_type");
	}
	if (
		expression.kind === "count" &&
		"kind" in expression.via &&
		expression.via.kind === "subcase"
	)
		return subcaseCount(expression, path, emission);
	throw new Error(
		`csqlEmitter: a '${expression.kind}' reached a comparison's query side, which CommCare's search reads only as a case property, the case type or a child-case count. The CSQL representability rule refuses this shape.`,
	);
}

/** `subcase-count('<id>', <filter>)` on a comparison's left, the one place
 * HQ's `_is_subcase_count` reads it. */
function subcaseCount(
	expression: Extract<Expression, { kind: "count" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const via = expression.via;
	if (!("kind" in via) || via.kind !== "subcase")
		throw new Error("csqlEmitter: only a child-case count is a query side.");
	writeRelatedCaseQuery("subcase-count");
	if (expression.where === undefined && via.ofCaseType === undefined)
		return c.query("subcase-count", [c.literal(via.identifier)]);
	return c.query("subcase-count", [
		c.literal(via.identifier),
		c.group(
			withCaseType(
				via.ofCaseType,
				expression.where === undefined
					? c.query("match-all")
					: query(
							expression.where,
							operandPath(expression, "where", path),
							childEmission(expression, "where", emission),
						),
			),
		),
	]);
}

/**
 * HQ parses a `subcase-count` bound with Python's `int(...)`: a quoted prompt
 * or `double(prompt)` is refused and a fraction truncated, so the bound is
 * one bare nonnegative integer token, a prompt's held to it on the device.
 */
function subcaseCountBound(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const classification = classifySubcaseCountBound(
		expression,
		searchInputs(emission),
		emission.bindings?.searchInputInstanceId,
	);
	if (classification.kind === "static-valid")
		return c.number(classification.value);
	if (classification.kind === "runtime-input")
		return c.runtime({
			key: csqlPositionKey(path),
			value: classification.inputXPath,
			quoting: "bare",
			// CSQL reads a leading minus as a unary expression, even on zero, so
			// every zero spelling becomes the bare `0`.
			print: w.call("if", [
				w.eq(w.call("number", [classification.inputXPath]), w.num(0)),
				w.num(0),
				classification.inputXPath,
			]),
			obligation: {
				condition: invalidNonnegativeWholeNumberXPath(
					classification.inputXPath,
				),
				kind: "nonnegative-whole-number",
				inputNames: [classification.inputName],
			},
		});
	throw new Error(
		"csqlEmitter: a subcase-count comparison needs a fixed nonnegative whole number or one Number-converted search input. CCHQ's parser cannot consume a quoted or computed bound and truncates fractional values. The CSQL representability validator should have rejected this expression before compilation.",
	);
}

// ── server values and raw arguments ──────────────────────────────────────

function value(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	if (positionAt(emission, path) === "runtime")
		return c.runtime(runtimeHole(expression, path, emission));
	switch (expression.kind) {
		case "term":
			return termValue(expression.term);
		case "now":
			return c.value("now");
		case "date-coerce":
		case "datetime-coerce":
			return c.value(expression.kind === "date-coerce" ? "date" : "datetime", [
				epochOperand(
					expression,
					operandPath(expression, "value", path),
					emission,
				),
			]);
		case "double":
			return c.value("double", [
				value(
					expression.value,
					operandPath(expression, "value", path),
					emission,
				),
			]);
		case "date-add":
			return dateAdd(expression, path, emission);
		case "value-list":
			return c.value("unwrap-list", [valueList(expression, path, emission)]);
		default:
			throw new Error(
				`csqlEmitter: a '${expression.kind}' reached a value CommCare's search evaluates itself, but it is none of HQ's value functions. Its position should have made it a runtime value.`,
			);
	}
}

function termValue(term: Term): CsqlNode {
	switch (term.kind) {
		case "literal":
			if (term.value === null) return c.literal("");
			if (typeof term.value === "number") return c.number(term.value);
			if (typeof term.value === "boolean")
				return c.literal(term.value ? "true" : "false");
			return c.literal(term.value);
		case "case-type":
			return c.literal(term.caseType);
		default:
			throw new Error(
				`csqlEmitter: '${term.kind}' cannot be a value CommCare's search reads; it is a case read on the value side, which the CSQL representability rule refuses.`,
			);
	}
}

/**
 * A `date()` or `datetime()` operand. A number of days the device works out
 * is spliced in unquoted as Core's `number(x)`, which prints an integer when
 * whole (`FunctionUtils.java::toString`): a quoted digit string reaches HQ's
 * `parse_date` and is refused (`value_functions.py::value_to_date`). HQ's
 * `date()` refuses a fraction, so its operand is held to a whole number;
 * `datetime()`'s to a number Core prints without an exponent HQ's lexer
 * cannot read.
 */
function epochOperand(
	parent: Extract<Expression, { kind: "date-coerce" | "datetime-coerce" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const operand = parent.value;
	const data = scalarDataType(typeOf(operand, emission.types)?.data);
	if (
		positionAt(emission, path) !== "runtime" ||
		(data !== "int" && data !== "decimal")
	)
		return value(operand, path, emission);
	const read = runtimeWire(operand, emission);
	const number = w.call("number", [read]);
	const names = blamedInputs(operand, emission);
	return c.runtime({
		key: csqlPositionKey(path),
		value: read,
		quoting: "bare",
		print: number,
		obligation: {
			condition:
				parent.kind === "date-coerce"
					? invalidWholeNumberXPath(read)
					: w.or(
							w.not(w.eq(number, number)),
							w.call("contains", [w.call("string", [number]), w.str("E")]),
						),
			kind: parent.kind === "date-coerce" ? "whole-number" : "decimal-number",
			inputNames: names,
		},
	});
}

/**
 * `date-add(<date>, '<interval>', <quantity>)` or `datetime-add(…)`
 * (`value_functions.py::_date_or_datetime_add`, three arguments). The two
 * keep or drop the time, so the date operand's type picks one; HQ's calendar
 * shifts take a whole number of months or years.
 */
function dateAdd(
	expression: Extract<Expression, { kind: "date-add" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	const temporal = asTemporalType(
		scalarDataType(typeOf(expression.date, emission.types)?.data),
	);
	if (temporal === undefined)
		throw new Error(
			"csqlExpressionEmitter: cannot choose between CCHQ's date-add() and datetime-add() for this date-add expression. The wire functions have different result semantics, so the emitter will not guess from a property name, input name, interval, or runtime string. The actual slot context did not resolve the date operand to date or datetime. Validation should reject this expression before wire compilation.",
		);
	const quantityPath = operandPath(expression, "quantity", path);
	let quantity = value(expression.quantity, quantityPath, emission);
	if (expression.interval === "months" || expression.interval === "years") {
		const classification = classifyCalendarDateAddQuantity(
			expression.quantity,
			searchInputs(emission),
			emission.bindings?.searchInputInstanceId,
		);
		if (classification.kind === "unsupported")
			throw new Error(
				"csqlExpressionEmitter: calendar-relative date-add quantities must be a fixed whole number or one Number-converted search input. CCHQ rejects fractional months/years, and emitting an unconstrained runtime calculation would make Preview and the exported search disagree. The CSQL representability validator should have rejected this expression before compilation.",
			);
		if (classification.kind === "runtime-input")
			quantity = c.guarded(quantity, {
				condition: invalidWholeNumberXPath(classification.inputXPath),
				kind: "whole-number",
				inputNames: [classification.inputName],
			});
	}
	quantity = groupedValueFunction(
		expression.quantity,
		quantityPath,
		emission,
		quantity,
	);
	return c.value(temporal === "date" ? "date-add" : "datetime-add", [
		value(expression.date, operandPath(expression, "date", path), emission),
		c.literal(expression.interval),
		quantity,
	]);
}

/**
 * HQ's `unwrap-list('<json>')` (`value_functions.py::unwrap_list`, a raw JSON
 * string). A value the device works out sits inside a JSON string, held away
 * from a double quote, a backslash, a control character and a single quote,
 * any of which would break the JSON or the CSQL literal around it.
 */
function valueList(
	expression: Extract<Expression, { kind: "value-list" }>,
	path: CheckPath,
	emission: Emission,
): CsqlNode {
	return {
		k: "json-list",
		items: expression.items.map((item, index) => {
			const entryPath = itemPath(expression, "items", index, path);
			if (positionAt(emission, entryPath) !== "runtime") {
				if (item.kind !== "term")
					throw new Error(
						"csqlEmitter: a value-list item is a fixed value or one the device works out.",
					);
				const literal = termValue(item.term);
				return {
					k: "item" as const,
					value:
						literal.k === "number"
							? formatNumeric(literal.value)
							: literal.k === "literal"
								? literal.value
								: "",
				};
			}
			const read = runtimeWire(item, emission);
			const data = typeOf(item, emission.types)?.data;
			const many =
				typeof data === "object" &&
				data !== null &&
				data.cardinality === "many";
			const unsafe = (subject: WireExpr) =>
				w.or(
					w.call("regex", [subject, w.str(CSQL_LIST_ITEM_UNSAFE_PATTERN)]),
					w.call("contains", [subject, w.str("'")]),
				);
			if (many && read.k === "path") {
				const last = read.steps.at(-1);
				if (last === undefined)
					throw new Error("csqlEmitter: a node-set item has no final step.");
				const unsafeNodes = w.path(read.root, [
					...read.steps.slice(0, -1),
					{ ...last, predicates: [...last.predicates, unsafe(w.context())] },
				]);
				return {
					k: "runtime" as const,
					hole: {
						key: csqlPositionKey(entryPath),
						value: read,
						quoting: "quote-free" as const,
						print: w.call("join", [w.str('","'), read]),
						obligation: {
							condition: w.gt(w.call("count", [unsafeNodes]), w.num(0)),
							kind: "list-item" as const,
						},
					},
				};
			}
			return {
				k: "runtime" as const,
				hole: {
					key: csqlPositionKey(entryPath),
					value: read,
					quoting: "quote-free" as const,
					obligation: { condition: unsafe(read), kind: "list-item" as const },
				},
			};
		}),
	};
}

// ── runtime holes ────────────────────────────────────────────────────────

function holeInputNames(
	expression: Expression,
	emission: Emission,
): readonly string[] | undefined {
	if (expression.kind === "term")
		return expression.term.kind === "input"
			? [inputName(expression.term.searchInputUuid, emission)]
			: undefined;
	return blamedInputs(expression, emission);
}

/**
 * A value the device works out, spliced into the text as a CSQL string. A
 * date picker's answer (`yyyy-MM-dd` on every runtime that binds one:
 * `QueryScreen.java::getSupportedPrompts`) and `today()` (Core prints a date
 * `yyyy-MM-dd`, `FunctionUtils.java::toString`) hold no quote and sit
 * between fixed double quotes; any other value takes the delimiter the
 * device picks for it.
 */
function runtimeHole(
	expression: Expression,
	path: CheckPath,
	emission: Emission,
): CsqlRuntimeHole {
	const key = csqlPositionKey(path);
	const read = runtimeWire(expression, emission);
	if (expression.kind === "today")
		return { key, value: read, quoting: "quote-free", neverBlank: true };
	if (
		expression.kind === "term" &&
		expression.term.kind === "input" &&
		searchInputs(emission).find(
			(input) =>
				expression.term.kind === "input" &&
				input.uuid === expression.term.searchInputUuid,
		)?.data_type === "date"
	)
		return { key, value: read, quoting: "quote-free" };
	const names = holeInputNames(expression, emission);
	return {
		key,
		value: read,
		quoting: "quoted",
		...(names === undefined ? {} : { inputNames: names }),
	};
}

/** Search inputs whose bytes can reach one runtime geopoint center. A
 * selector (`if.cond`, `switch.on`, a count's filter) decides which output is
 * used but is not location text, so it is not blamed. */
export function collectGeopointCenterInputNames(
	expression: Expression,
): ReadonlySet<string> {
	const names = new Set<string>();
	const visit = (node: Expression): void => {
		switch (node.kind) {
			case "term":
				if (node.term.kind === "input") names.add(node.term.searchInputUuid);
				return;
			case "date-coerce":
			case "datetime-coerce":
			case "double":
				visit(node.value);
				return;
			case "format-date":
				visit(node.date);
				return;
			case "date-add":
				visit(node.date);
				visit(node.quantity);
				return;
			case "arith":
				visit(node.left);
				visit(node.right);
				return;
			case "concat":
				for (const part of node.parts) visit(part);
				return;
			case "coalesce":
				for (const candidate of node.values) visit(candidate);
				return;
			case "if":
				visit(node.then);
				visit(node.else);
				return;
			case "switch":
				for (const entry of node.cases) visit(entry.then);
				visit(node.fallback);
				return;
			case "table-lookup": {
				// The lookup result becomes the geopoint, but an input in its row
				// filter can select a different result.
				const walk = (child: Expression | Term): void => {
					if (child.kind === "input") names.add(child.searchInputUuid);
					for (const entry of expressionChildren(child))
						if (entry.kind !== "relation") walk(entry.value);
				};
				walk(node.where);
				return;
			}
			default:
				return;
		}
	};
	visit(expression);
	return names;
}
