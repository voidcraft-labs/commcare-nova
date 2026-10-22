/**
 * Static representability contract for predicates emitted as CCHQ CSQL.
 *
 * CSQL resembles XPath, but its server parser is deliberately much narrower:
 * ordinary comparisons require a case-property `Step` on the left and reject
 * a property `Step` anywhere on the right. The one alternate left-hand shape
 * is `subcase-count(...)`. Values that depend only on literals, search/session
 * data, and pure expressions can be evaluated by the on-device `concat(...)`
 * wrapper and inserted as the right-hand scalar. Values that read case data
 * cannot: the remote-request screen has no current case context, and CCHQ must
 * evaluate those reads per Elasticsearch result instead.
 *
 * This module is the single typed model of that boundary. The validator uses
 * {@link checkCsqlRepresentability} for friendly authoring errors; the emitter
 * uses {@link normalizeCsqlPredicate} to canonicalize the valid reversible
 * case where the sole query anchor was authored on the right.
 */

import {
	expressionChildPath,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import {
	type CsqlPosition,
	type CsqlPositionMap,
	csqlPositionAt,
	csqlPositionKey,
	csqlPositions,
	csqlRuntimeRoots,
	isCsqlQueryAnchor,
} from "@/lib/domain/expression/csqlPositions";
import { fixedDatePattern } from "@/lib/domain/expression/datePattern";
import { unhandledKindMessage } from "@/lib/domain/expression/errors";
import { mapExpressionChildren } from "@/lib/domain/expression/mapAst";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import type {
	ComparisonKind,
	Expression,
	Literal,
} from "@/lib/domain/expression/types";
import {
	isConditionArm,
	isRelationPath,
	type Term,
} from "@/lib/domain/expression/types";
import {
	SYSTEM_DATETIME_CASE_PROPERTIES,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain/standardCaseProperties";
import { materializeCsqlChoices } from "./choices";
import { isCsqlStringLiteralRepresentable } from "./print";
import {
	isRepresentableCalendarDateAddQuantity,
	isRepresentableSubcaseCountBound,
} from "./runtimeCsqlNumericSafety";

export type CsqlRepresentabilityReason =
	| "comparison-needs-case-property"
	| "case-property-on-value-side"
	| "related-count-on-value-side"
	| "unsupported-related-count"
	| "self-relation-not-queryable"
	| "case-query-in-runtime-value"
	| "csql-string-not-quotable"
	| "calendar-date-add-needs-whole-number"
	| "subcase-count-needs-nonnegative-whole-number"
	| "multiple-property-scopes"
	| "form-context-value-not-csql"
	| "pattern-match-not-csql"
	| "system-datetime-value"
	| "epoch-days-not-whole"
	| "raw-argument-not-evaluated"
	| "value-list-placement";

export interface CsqlRepresentabilityIssue {
	readonly reason: CsqlRepresentabilityReason;
	readonly path: readonly (string | number)[];
	readonly message: string;
	/**
	 * For `system-datetime-value`: the system date read (`property`) and
	 * what was asked of it (`shape`, `is-blank` or `null-value`).
	 */
	readonly details?: Readonly<Record<string, string>>;
}

const SWAPPED_COMPARISON_KIND: Readonly<
	Record<ComparisonKind, ComparisonKind>
> = {
	eq: "eq",
	neq: "neq",
	gt: "lt",
	gte: "lte",
	lt: "gt",
	lte: "gte",
};

/** Return every CSQL boundary violation without changing the authored AST. */
export function checkCsqlRepresentability(
	predicate: Expression,
	context: ExpressionContext,
): readonly CsqlRepresentabilityIssue[] {
	const issues: CsqlRepresentabilityIssue[] = [];
	const tree = materializeCsqlChoices(predicate, context);
	check(tree, [], {
		positions: csqlPositions(tree),
		runtimeRoots: new Map(
			csqlRuntimeRoots(tree).map((root) => [
				csqlPositionKey(root.path),
				root.within,
			]),
		),
		context,
		issues,
	});
	return issues;
}

/**
 * Put a query anchor authored on the right onto CCHQ's required left side.
 *
 * `2 < prop(age)` becomes `prop(age) > 2`; equality/inequality simply swap.
 * The same normalization applies to a direct `subcase-count(...)` anchor.
 * Property-via lifting runs after this pass, so a related property authored on
 * the right is canonicalized before its relation becomes an exists envelope.
 */
export function normalizeCsqlPredicate(expression: Expression): Expression {
	const normalized = mapExpressionChildren(expression, (child) =>
		child.kind === "expression"
			? normalizeCsqlPredicate(child.value)
			: child.kind === "term"
				? normalizeTerm(child.value)
				: child.value,
	);
	if (
		(normalized.kind === "eq" ||
			normalized.kind === "neq" ||
			normalized.kind === "lt" ||
			normalized.kind === "lte" ||
			normalized.kind === "gt" ||
			normalized.kind === "gte") &&
		!isCsqlQueryAnchor(normalized.left) &&
		isCsqlQueryAnchor(normalized.right)
	) {
		return {
			kind: SWAPPED_COMPARISON_KIND[normalized.kind],
			left: normalized.right,
			right: normalized.left,
		};
	}
	return normalized;
}
function normalizeTerm(term: Term): Term {
	return mapExpressionChildren(term, (child) =>
		child.kind === "expression"
			? normalizeCsqlPredicate(child.value)
			: child.kind === "term"
				? normalizeTerm(child.value)
				: child.value,
	);
}

type Path = readonly (string | number)[];

interface Walk {
	readonly positions: CsqlPositionMap;
	/** Each runtime subtree's root, by key, and the position it sits in. */
	readonly runtimeRoots: ReadonlyMap<string, CsqlPosition>;
	readonly context: ExpressionContext;
	readonly issues: CsqlRepresentabilityIssue[];
}

function positionOf(walk: Walk, path: Path): CsqlPosition | undefined {
	return csqlPositionAt(walk.positions, path);
}

/**
 * One switch over (arm, position). Each node is checked where it sits: a
 * clause in a query position, a comparison's query side as an anchor, a
 * value HQ evaluates or reads as written, and a subtree the device works out
 * before HQ sees the text.
 */
function check(node: Expression, path: Path, walk: Walk): void {
	switch (positionOf(walk, path)) {
		case "runtime":
			checkRuntime(node, path, walk);
			return;
		case "server-value":
		case "raw":
			checkValue(node, path, walk);
			return;
		case "anchor":
			checkAnchor(node, path, walk);
			return;
		default:
			checkQuery(node, path, walk);
	}
}

function children(node: Expression, path: Path, walk: Walk): void {
	for (const child of expressionChildren(node, path))
		if (child.kind === "expression") check(child.value, child.path, walk);
		else if (child.kind === "term")
			checkTermValue(child.value, child.path, walk);
}

function checkQuery(node: Expression, path: Path, walk: Walk): void {
	const { issues } = walk;
	if (!isConditionArm(node)) {
		if (node.kind === "if" || node.kind === "switch") {
			if (node.kind === "switch" && !checkSwitchComparisons(node, path, walk))
				return;
			children(node, path, walk);
			return;
		}
		issues.push({
			reason: "comparison-needs-case-property",
			path,
			message: "This search needs a case condition.",
		});
		return;
	}
	switch (node.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const swapped =
				!isCsqlQueryAnchor(node.left) && isCsqlQueryAnchor(node.right);
			if (
				!checkComparison(
					node.kind,
					swapped ? node.right : node.left,
					swapped ? node.left : node.right,
					path,
					[...path, swapped ? "left" : "right"],
					walk,
				)
			)
				return;
			children(node, path, walk);
			return;
		}
		case "in": {
			checkSystemDatetimeValue(
				node.left,
				node.values.map(
					(value): Expression => ({
						kind: "term",
						term: { kind: "literal", value: literalValue(value) },
					}),
				),
				path,
				issues,
			);
			const subcase =
				node.left.kind === "count" &&
				isRelationPath(node.left.via) &&
				node.left.via.kind === "subcase";
			node.values.forEach((value, index) => {
				const valuePath = [...path, "values", index];
				if (subcase)
					checkSubcaseCountBound(
						{
							kind: "term",
							term: { kind: "literal", value: literalValue(value) },
						},
						valuePath,
						issues,
					);
				else checkCsqlLiteral(literalValue(value), valuePath, issues);
			});
			check(node.left, [...path, "left"], walk);
			return;
		}
		case "between": {
			const bounds = [
				...(node.lower === undefined ? [] : [node.lower]),
				...(node.upper === undefined ? [] : [node.upper]),
			];
			if (hasMultiplePropertyScopes([node.left, ...bounds])) {
				issues.push({
					reason: "multiple-property-scopes",
					path,
					message:
						"This range compares properties from different cases. Choose one property and give it fixed or entered bounds, or make separate related-case conditions.",
				});
				return;
			}
			checkSystemDatetimeValue(node.left, bounds, path, issues);
			if (
				node.left.kind === "count" &&
				isRelationPath(node.left.via) &&
				node.left.via.kind === "subcase"
			) {
				if (node.lower !== undefined)
					checkSubcaseCountBound(node.lower, [...path, "lower"], issues);
				if (node.upper !== undefined)
					checkSubcaseCountBound(node.upper, [...path, "upper"], issues);
			}
			for (const slot of ["lower", "upper"] as const) {
				const bound = node[slot];
				if (bound !== undefined && containsValueList(bound))
					pushValueListPlacement([...path, slot], issues);
			}
			children(node, path, walk);
			return;
		}
		case "is-blank": {
			if (node.left.kind === "term" && node.left.term.kind === "literal")
				return;
			checkPropertyOnlyLeft(node.left, [...path, "left"], issues);
			const system = systemDatetimeProperty(node.left);
			if (system !== undefined)
				issues.push({
					reason: "system-datetime-value",
					path,
					message: `CommCare's search can't ask whether ${standardCasePropertyDisplayLabel(system)} is blank. Every case has one.`,
					details: { property: system, shape: "is-blank" },
				});
			return;
		}
		case "matches-pattern":
			issues.push({
				reason: "pattern-match-not-csql",
				path,
				message:
					"A pattern match can only run on the device, in a Search field's required condition or check. Search itself has no pattern matching. Use a text match or a comparison here.",
			});
			return;
		case "match":
		case "multi-select-contains":
			checkPropertyOnlyLeft(
				node.property.kind === "prop"
					? { kind: "term", term: node.property }
					: node.property,
				[...path, "property"],
				issues,
			);
			children(node, path, walk);
			return;
		case "within-distance":
			children(node, path, walk);
			return;
		case "exists":
		case "missing":
			if (node.via.kind === "self")
				issues.push({
					reason: "self-relation-not-queryable",
					path: [...path, node.kind, "via"],
					message:
						"Choose a parent or child relationship for this related-case condition. 'This case' does not point to a related case.",
				});
			children(node, path, walk);
			return;
		case "and":
		case "or":
		case "not":
		case "when-input-present":
			children(node, path, walk);
			return;
		default: {
			const exhaustive: never = node;
			throw new Error(
				unhandledKindMessage({
					where: "checkCsqlRepresentability",
					family: "Expression",
					received: (exhaustive as { kind?: unknown })?.kind ?? exhaustive,
					knownKinds: [],
				}),
			);
		}
	}
}

/**
 * The checks one comparison of a query side and a value gets, before its
 * operands are checked where they sit. `path` is the comparison's own and
 * `valuePath` its value side's. False when the comparison reads two cases'
 * properties, whose operands are not checked further.
 */
function checkComparison(
	kind: ComparisonKind,
	anchor: Expression,
	other: Expression,
	path: Path,
	valuePath: Path,
	walk: Walk,
): boolean {
	const { issues } = walk;
	if (hasMultiplePropertyScopes([anchor, other])) {
		issues.push({
			reason: "multiple-property-scopes",
			path,
			message:
				"This search compares properties from different cases. Choose one property and compare it with a value, or make separate related-case conditions.",
		});
		return false;
	}
	checkSystemDatetimeValue(anchor, [other], path, issues);
	if (
		anchor.kind === "count" &&
		isRelationPath(anchor.via) &&
		anchor.via.kind === "subcase"
	)
		checkSubcaseCountBound(other, valuePath, issues);
	if (kind !== "eq" && kind !== "neq" && containsValueList(other))
		pushValueListPlacement(valuePath, issues);
	else if (containsValueList(other) && readsMoment(anchor, walk.context))
		pushValueListPlacement(valuePath, issues, MOMENT_LIST_MESSAGE);
	else if (containsValueList(other) && !admitsValueList(anchor))
		pushValueListPlacement(valuePath, issues);
	return true;
}

/**
 * A switch whose selector reads the row is HQ's own clause, each case the
 * comparison `on = when` (`emitter.ts::switchChoice`), so each case gets the
 * checks an authored `eq` of the two gets. A selector the device decides is
 * no comparison HQ reads. False when a case reads two cases' properties.
 */
function checkSwitchComparisons(
	node: Extract<Expression, { kind: "switch" }>,
	path: Path,
	walk: Walk,
): boolean {
	const onPath = expressionChildPath(
		"switch",
		{ kind: "operand", slot: "on" },
		path,
	);
	if (positionOf(walk, onPath) !== "anchor") return true;
	let checked = true;
	node.cases.forEach((entry, index) => {
		const whenPath = expressionChildPath(
			"switch",
			{ kind: "switch-case", index, slot: "when" },
			path,
		);
		if (
			!checkComparison(
				"eq",
				node.on,
				{ kind: "term", term: entry.when },
				whenPath,
				whenPath,
				walk,
			)
		)
			checked = false;
	});
	return checked;
}

function checkAnchor(node: Expression, path: Path, walk: Walk): void {
	if (node.kind === "term") {
		if (node.term.kind === "prop" || node.term.kind === "case-row-type") return;
	} else if (node.kind === "count") {
		if (!isRelationPath(node.via) || node.via.kind !== "subcase") {
			walk.issues.push({
				reason: "unsupported-related-count",
				path,
				message:
					"This search can count child cases, but not parent cases or relationships in either direction. Choose a child relationship.",
			});
			return;
		}
		children(node, path, walk);
		return;
	}
	walk.issues.push({
		reason: "comparison-needs-case-property",
		path,
		message:
			"Choose one case property as the field to search, then compare it with a fixed, entered, or calculated value.",
	});
}

/** A term child of a value node: a literal HQ reads, or a case read on the
 * value side. */
function checkTermValue(term: Term, path: Path, walk: Walk): void {
	const position = positionOf(walk, path);
	if (position === "runtime" || position === "anchor") return;
	if (term.kind === "literal") checkCsqlLiteral(term.value, path, walk.issues);
	else if (term.kind === "prop" || term.kind === "case-row-type")
		pushPropertyOnValueSide(path, walk.issues);
}

function pushPropertyOnValueSide(
	path: Path,
	issues: CsqlRepresentabilityIssue[],
): void {
	issues.push({
		reason: "case-property-on-value-side",
		path,
		message:
			"This search compares two case properties. Choose one property and compare it with a fixed value, a search answer, or a user detail instead.",
	});
}

/** A value HQ evaluates (`server-value`) or reads as written (`raw`). */
function checkValue(node: Expression, path: Path, walk: Walk): void {
	const { issues } = walk;
	switch (node.kind) {
		case "term":
			checkTermValue(node.term, path, walk);
			return;
		case "date-add":
			if (
				(node.interval === "months" || node.interval === "years") &&
				!isRepresentableCalendarDateAddQuantity(node.quantity)
			)
				issues.push({
					reason: "calendar-date-add-needs-whole-number",
					path: [...path, "quantity"],
					message:
						"Month and year shifts need a whole number. Use a fixed whole number or convert one search answer to Number; use days or weeks for fractional durations.",
				});
			children(node, path, walk);
			return;
		case "date-coerce": {
			// HQ's `date()` counts whole days and refuses a float
			// (`value_functions.py::value_to_date`).
			const operand = node.value;
			const data = scalarDataType(typeOf(operand, walk.context)?.data);
			const literal =
				operand.kind === "term" && operand.term.kind === "literal"
					? operand.term.value
					: undefined;
			// A decimal value the device works out first is admitted: its
			// runtime print carries the `whole-number` obligation, which
			// sends `match-none()` for a fraction (`emitter.ts`).
			if (
				(typeof literal === "number" && !Number.isInteger(literal)) ||
				(literal === undefined &&
					data === "decimal" &&
					positionOf(walk, [...path, "value"]) !== "runtime")
			)
				issues.push({
					reason: "epoch-days-not-whole",
					path: [...path, "value"],
					message:
						"CommCare's search counts days in whole numbers. Use a whole number of days.",
				});
			children(node, path, walk);
			return;
		}
		case "value-list":
			// A fixed item is JSON inside one CSQL literal, its quotes escaped
			// (`print.ts`), so any text is representable; an item the device
			// works out is held to the `list-item` obligation.
			for (const child of expressionChildren(node, path))
				if (
					child.kind === "expression" &&
					positionOf(walk, child.path) === "runtime"
				)
					check(child.value, child.path, walk);
			return;
		default:
			children(node, path, walk);
	}
}

/** A subtree the device works out inside the `_xpath_query` concat. */
function checkRuntime(node: Expression, path: Path, walk: Walk): void {
	const { issues } = walk;
	const within = runtimeRootPosition(walk, path);
	if (within === "raw" && computedOnlyByHq(node))
		issues.push({
			reason: "raw-argument-not-evaluated",
			path,
			message:
				"CommCare's search uses this value as written and won't calculate it. Choose a fixed value or one the device can work out.",
		});
	if (
		(within === "server-value" || within === "raw") &&
		hasReachableStaticallyUnquotableOutput(node)
	)
		pushUnquotableCsqlStringIssue(path, issues);
	checkRuntimeNode(node, path, walk);
}

/** The position a runtime subtree's root sits in. */
function runtimeRootPosition(walk: Walk, path: Path): CsqlPosition | undefined {
	return walk.runtimeRoots.get(csqlPositionKey(path));
}

/** A value only HQ's search can calculate, which a raw argument never runs. */
function computedOnlyByHq(node: Expression): boolean {
	if (node.kind === "datetime-coerce") return true;
	if (
		node.kind === "date-add" &&
		(node.interval === "months" || node.interval === "years")
	)
		return true;
	return expressionChildren(node).some(
		(child) => child.kind === "expression" && computedOnlyByHq(child.value),
	);
}

function checkRuntimeNode(
	node: Expression | Term,
	path: Path,
	walk: Walk,
): void {
	const { issues } = walk;
	switch (node.kind) {
		case "prop":
		case "case-row-type":
		case "case-index":
			pushPropertyOnValueSide(path, issues);
			return;
		case "term":
			checkRuntimeNode(node.term, path, walk);
			return;
		case "field":
		case "form-node":
		case "repeat-row":
		case "form-case":
			issues.push({
				reason: "form-context-value-not-csql",
				path,
				message:
					"A form-field value is available during form submission, not while the remote case-search query runs.",
			});
			return;
		case "id-of":
		case "acting-user":
		case "unowned":
			issues.push({
				reason: "form-context-value-not-csql",
				path,
				message:
					node.kind === "id-of"
						? "A case-operation id is available during form submission, not while the remote case-search query runs."
						: "An operation owner identity is available during form submission, not while the remote case-search query runs.",
			});
			return;
		case "call":
		case "itext":
		case "choice-name":
		case "here":
		case "selected-cases":
			issues.push({
				reason: "form-context-value-not-csql",
				path,
				message:
					"This value is unavailable while the remote case-search query runs.",
			});
			return;
		case "value-list":
			pushValueListPlacement(path, issues);
			return;
		case "count":
			if (isRelationPath(node.via)) {
				issues.push({
					reason: "related-count-on-value-side",
					path,
					message:
						"Put the child-case count on the left side of the condition, then compare it with a fixed or entered whole number.",
				});
				return;
			}
			break;
		case "match":
		case "multi-select-contains":
		case "within-distance":
		case "exists":
		case "missing":
			issues.push({
				reason: "case-query-in-runtime-value",
				path,
				message:
					"This calculation needs a case row before search results exist. Move the case condition out of the calculation and into the surrounding rule.",
			});
			return;
		case "table-lookup":
			// A lookup row's own filter is typed and checked in its row scope by
			// the checker and the device rules; CSQL's grammar does not reach it.
			return;
		case "cases":
		case "table-rows":
		case "locations":
		case "project":
			// Held reads of their own rows (part 06 §3.9): their filters read
			// those rows, never the search's.
			return;
		default:
			break;
	}
	for (const child of expressionChildren(node, path))
		if (child.kind !== "relation")
			checkRuntimeNode(child.value, child.path, walk);
}

function checkPropertyOnlyLeft(
	expression: Expression,
	path: Path,
	issues: CsqlRepresentabilityIssue[],
): void {
	if (isPropertyExpression(expression)) return;
	issues.push({
		reason: "comparison-needs-case-property",
		path,
		message:
			"Choose a case property as the field to search. Use inputs and calculations only for the value.",
	});
}

function checkSubcaseCountBound(
	expression: Expression,
	path: Path,
	issues: CsqlRepresentabilityIssue[],
): void {
	if (!isRepresentableSubcaseCountBound(expression))
		issues.push({
			reason: "subcase-count-needs-nonnegative-whole-number",
			path,
			message:
				"Compare the child-case count with a whole number that is zero or greater. Use a fixed number or convert one search answer to Number.",
		});
}

/** Anchors HQ compares with a list (`comparison.py::_create_system_query`,
 * `es/case_search.py::case_property_query`); `@status` and the system dates
 * are not among them. */
function admitsValueList(anchor: Expression): boolean {
	if (anchor.kind !== "term") return false;
	if (anchor.term.kind === "case-row-type") return true;
	if (anchor.term.kind !== "prop") return false;
	const property = anchor.term.property;
	if (property === "status" || SYSTEM_DATETIME_CASE_PROPERTIES.has(property))
		return false;
	return true;
}

/**
 * Whether a list's anchor is a date and time. HQ answers `p = unwrap-list(…)`
 * on a custom property with exact text terms (`es/case_search.py::case_property_query`,
 * `es/filters.py::term`), the text equality of finding 75, so a list can't
 * mean the moment each item names; the system dates are refused already.
 */
function readsMoment(anchor: Expression, context: ExpressionContext): boolean {
	return (
		anchor.kind === "term" &&
		anchor.term.kind === "prop" &&
		scalarDataType(typeOf(anchor, context)?.data) === "datetime"
	);
}

const MOMENT_LIST_MESSAGE =
	"A list of values can't be compared with a date and time. CommCare's search matches each listed value by its exact text, not by the moment it names, so compare the property with each value in its own condition instead.";

function containsValueList(node: Expression): boolean {
	return node.kind === "value-list";
}

function pushValueListPlacement(
	path: Path,
	issues: CsqlRepresentabilityIssue[],
	message = "A list of values can be compared only as equal or not equal to a case value.",
): void {
	issues.push({ reason: "value-list-placement", path, message });
}

/**
 * The system date a CSQL anchor reads, if it reads one. CommCare's search
 * sends `date_opened`, `closed_on` and `last_modified` to its system datetime
 * query whatever the operator, and that query raises on `''`
 * (`corehq/apps/case_search/xpath_functions/comparison.py::property_comparison_query`).
 */
function systemDatetimeProperty(expression: Expression): string | undefined {
	return expression.kind === "term" &&
		expression.term.kind === "prop" &&
		SYSTEM_DATETIME_CASE_PROPERTIES.has(expression.term.property)
		? expression.term.property
		: undefined;
}

/**
 * Refuse the null literal as a fixed value compared with a system date: Nova
 * prints it as `''`, which HQ's system datetime query cannot read. Every
 * other fixed value that is not a date and time is already a type error, and
 * a runtime value is guarded by the emitter (`runtimeCsqlDateSafety.ts`).
 */
function checkSystemDatetimeValue(
	anchor: Expression,
	values: readonly Expression[],
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	const system = systemDatetimeProperty(anchor);
	if (system === undefined) return;
	const comparesNull = values.some(
		(value) =>
			value.kind === "term" &&
			value.term.kind === "literal" &&
			value.term.value === null,
	);
	if (!comparesNull) return;
	issues.push({
		reason: "system-datetime-value",
		path,
		message: `${standardCasePropertyDisplayLabel(system)} is compared with a date and time.`,
		details: { property: system, shape: "null-value" },
	});
}

function checkCsqlLiteral(
	value: unknown,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	if (typeof value !== "string" || isCsqlStringLiteralRepresentable(value)) {
		return;
	}
	pushUnquotableCsqlStringIssue(path, issues);
}

function pushUnquotableCsqlStringIssue(
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	issues.push({
		reason: "csql-string-not-quotable",
		path,
		message:
			"This value uses both single and double quotation marks. Rewrite it to use only one kind.",
	});
}

/**
 * Conservatively evaluate the small subset of on-device expressions whose
 * string output is guaranteed at authoring time. Most non-native expressions
 * are protected by the runtime quote guard because their value depends on the
 * device session. Pure literal concatenation/coalescing and a statically chosen
 * branch are different: Nova already knows they will hit the unrepresentable
 * CSQL value, so waiting for runtime would turn an authoring error into a
 * failed search.
 */
function staticallyKnownOnDeviceString(
	expression: Expression,
): string | undefined {
	switch (expression.kind) {
		case "term":
			return expression.term.kind === "literal" &&
				typeof expression.term.value === "string"
				? expression.term.value
				: undefined;
		case "concat": {
			const parts = expression.parts.map(staticallyKnownOnDeviceString);
			return parts.every((part): part is string => part !== undefined)
				? parts.join("")
				: undefined;
		}
		case "coalesce": {
			const values = expression.values.map(staticallyKnownOnDeviceString);
			if (values.some((value) => value === undefined)) return undefined;
			return (values as string[]).find((value) => value.length > 0) ?? "";
		}
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return staticallyKnownOnDeviceString(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return staticallyKnownOnDeviceString(expression.else);
			}
			return agreedStaticString([
				staticallyKnownOnDeviceString(expression.then),
				staticallyKnownOnDeviceString(expression.else),
			]);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return staticallyKnownOnDeviceString(selected);
			}
			return agreedStaticString([
				...expression.cases.map((entry) =>
					staticallyKnownOnDeviceString(entry.then),
				),
				staticallyKnownOnDeviceString(expression.fallback),
			]);
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "format-date":
		case "table-lookup":
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Whether an on-device expression has any author-known reachable output that
 * necessarily contains both CSQL quote delimiters. Dynamic bytes remain the
 * runtime guard's responsibility, but a fixed bad branch is still an invalid
 * authored state even when a condition decides whether that branch runs.
 */
function hasReachableStaticallyUnquotableOutput(
	expression: Expression,
): boolean {
	const exact = staticallyKnownOnDeviceString(expression);
	if (exact !== undefined && !isCsqlStringLiteralRepresentable(exact)) {
		return true;
	}

	switch (expression.kind) {
		case "concat": {
			if (expression.parts.some(hasReachableStaticallyUnquotableOutput)) {
				return true;
			}
			const guaranteed = expression.parts.reduce<QuoteGuarantee>(
				(acc, part) => {
					const child = guaranteedQuoteKinds(part);
					return {
						single: acc.single || child.single,
						double: acc.double || child.double,
					};
				},
				{ single: false, double: false },
			);
			return guaranteed.single && guaranteed.double;
		}
		case "coalesce":
			for (const value of expression.values) {
				if (hasReachableStaticallyUnquotableOutput(value)) return true;
				if (isGuaranteedNonemptyString(value)) return false;
			}
			return false;
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return hasReachableStaticallyUnquotableOutput(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return hasReachableStaticallyUnquotableOutput(expression.else);
			}
			return (
				hasReachableStaticallyUnquotableOutput(expression.then) ||
				hasReachableStaticallyUnquotableOutput(expression.else)
			);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return hasReachableStaticallyUnquotableOutput(selected);
			}
			return (
				expression.cases.some((entry) =>
					hasReachableStaticallyUnquotableOutput(entry.then),
				) || hasReachableStaticallyUnquotableOutput(expression.fallback)
			);
		}
		case "format-date":
			return !isCsqlStringLiteralRepresentable(
				fixedDatePattern(expression.pattern) ?? "",
			);
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "table-lookup":
			return false;
		default:
			return false;
	}
}

/** Whether every evaluation returns a non-empty string. */
function isGuaranteedNonemptyString(expression: Expression): boolean {
	const known = staticallyKnownOnDeviceString(expression);
	if (known !== undefined) return known.length > 0;

	switch (expression.kind) {
		case "concat":
			return expression.parts.some(isGuaranteedNonemptyString);
		case "coalesce":
			return expression.values.some(isGuaranteedNonemptyString);
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return isGuaranteedNonemptyString(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return isGuaranteedNonemptyString(expression.else);
			}
			return (
				isGuaranteedNonemptyString(expression.then) &&
				isGuaranteedNonemptyString(expression.else)
			);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return isGuaranteedNonemptyString(selected);
			}
			return (
				expression.cases.every((entry) =>
					isGuaranteedNonemptyString(entry.then),
				) && isGuaranteedNonemptyString(expression.fallback)
			);
		}
		case "format-date":
			return (
				isGuaranteedTemporalValue(expression.date) &&
				(fixedDatePattern(expression.pattern) ?? "").length > 0
			);
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "table-lookup":
			return false;
		default:
			return false;
	}
}

interface QuoteGuarantee {
	readonly single: boolean;
	readonly double: boolean;
}

/** Quote kinds present in every possible string output of an expression. */
function guaranteedQuoteKinds(expression: Expression): QuoteGuarantee {
	const known = staticallyKnownOnDeviceString(expression);
	if (known !== undefined) {
		return { single: known.includes("'"), double: known.includes('"') };
	}
	switch (expression.kind) {
		case "concat":
			return expression.parts.reduce<QuoteGuarantee>(
				(acc, part) => {
					const child = guaranteedQuoteKinds(part);
					return {
						single: acc.single || child.single,
						double: acc.double || child.double,
					};
				},
				{ single: false, double: false },
			);
		case "coalesce": {
			const reachable: QuoteGuarantee[] = [];
			for (const value of expression.values) {
				if (staticallyKnownOnDeviceString(value) === "") continue;
				reachable.push(guaranteedQuoteKinds(value));
				if (isGuaranteedNonemptyString(value)) break;
			}
			return intersectQuoteGuarantees(reachable);
		}
		case "if": {
			const knownCondition = staticallyKnownPredicateBoolean(expression.cond);
			if (knownCondition === true) return guaranteedQuoteKinds(expression.then);
			if (knownCondition === false)
				return guaranteedQuoteKinds(expression.else);
			return intersectQuoteGuarantees([
				guaranteedQuoteKinds(expression.then),
				guaranteedQuoteKinds(expression.else),
			]);
		}
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) return guaranteedQuoteKinds(selected);
			return intersectQuoteGuarantees([
				...expression.cases.map((entry) => guaranteedQuoteKinds(entry.then)),
				guaranteedQuoteKinds(expression.fallback),
			]);
		}
		case "format-date": {
			if (!isGuaranteedTemporalValue(expression.date)) {
				return { single: false, double: false };
			}
			const pattern = fixedDatePattern(expression.pattern) ?? "";
			return {
				single: pattern.includes("'"),
				double: pattern.includes('"'),
			};
		}
		default:
			return { single: false, double: false };
	}
}

function intersectQuoteGuarantees(
	guarantees: readonly QuoteGuarantee[],
): QuoteGuarantee {
	if (guarantees.length === 0) return { single: false, double: false };
	return {
		single: guarantees.every((guarantee) => guarantee.single),
		double: guarantees.every((guarantee) => guarantee.double),
	};
}

interface StaticallyKnownPrimitive {
	readonly value: Literal["value"];
}

function staticallyKnownPrimitive(
	expression: Expression,
): StaticallyKnownPrimitive | undefined {
	if (expression.kind === "term" && expression.term.kind === "literal") {
		return { value: expression.term.value };
	}
	const stringValue = staticallyKnownOnDeviceString(expression);
	return stringValue === undefined ? undefined : { value: stringValue };
}

function staticPrimitiveEqual(
	left: Literal["value"],
	right: Literal["value"],
): boolean | undefined {
	// These are emitted XPath literals, not JavaScript values: null becomes
	// empty text and boolean literals become the strings 'true' and 'false'.
	// Core's XPathEqExpr compares numeric operands with an absolute tolerance.
	// Mixed numeric/text comparisons invoke Core's numeric/date conversion;
	// leave those unknown instead of duplicating that runtime here.
	const emittedLeft = typeof left === "number" ? left : String(left ?? "");
	const emittedRight = typeof right === "number" ? right : String(right ?? "");
	if (typeof emittedLeft === "number" && typeof emittedRight === "number") {
		return Math.abs(emittedLeft - emittedRight) < 1e-12;
	}
	if (typeof emittedLeft === "string" && typeof emittedRight === "string") {
		return emittedLeft === emittedRight;
	}
	return undefined;
}

/** Resolve only predicates whose result is independent of case/session data. */
function staticallyKnownPredicateBoolean(
	predicate: Expression,
): boolean | undefined {
	switch (predicate.kind) {
		case "match-all":
			return true;
		case "match-none":
			return false;
		case "eq":
		case "neq": {
			const left = staticallyKnownPrimitive(predicate.left);
			const right = staticallyKnownPrimitive(predicate.right);
			if (left === undefined || right === undefined) return undefined;
			const equal = staticPrimitiveEqual(left.value, right.value);
			if (equal === undefined) return undefined;
			return predicate.kind === "eq" ? equal : !equal;
		}
		case "and": {
			let hasUnknown = false;
			for (const clause of predicate.clauses) {
				const result = staticallyKnownPredicateBoolean(clause);
				if (result === false) return false;
				if (result === undefined) hasUnknown = true;
			}
			return hasUnknown ? undefined : true;
		}
		case "or": {
			let hasUnknown = false;
			for (const clause of predicate.clauses) {
				const result = staticallyKnownPredicateBoolean(clause);
				if (result === true) return true;
				if (result === undefined) hasUnknown = true;
			}
			return hasUnknown ? undefined : false;
		}
		case "not": {
			const result = staticallyKnownPredicateBoolean(predicate.clause);
			return result === undefined ? undefined : !result;
		}
		case "is-blank": {
			const value = staticallyKnownPrimitive(predicate.left);
			return value === undefined
				? undefined
				: value.value === null || value.value === "";
		}
		case "matches-pattern":
			// Deciding a Java regex statically would need the Pattern engine.
			return undefined;
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "between":
		case "match":
		case "multi-select-contains":
		case "within-distance":
		case "when-input-present":
		case "exists":
		case "missing":
			return undefined;
		default:
			return undefined;
	}
}

function staticallySelectedSwitchBranch(
	expression: Extract<Expression, { kind: "switch" }>,
): Expression | undefined {
	const discriminator = staticallyKnownPrimitive(expression.on);
	if (discriminator === undefined) return undefined;
	for (const entry of expression.cases) {
		const equal = staticPrimitiveEqual(
			discriminator.value,
			literalValue(entry.when),
		);
		if (equal === undefined) return undefined;
		if (equal) return entry.then;
	}
	return expression.fallback;
}

/** Whether a value is guaranteed to evaluate to a real temporal scalar. */
function isGuaranteedTemporalValue(expression: Expression): boolean {
	switch (expression.kind) {
		case "today":
		case "now":
			return true;
		case "term":
			return (
				expression.term.kind === "literal" &&
				typeof expression.term.value === "string" &&
				(expression.term.data_type === "date" ||
					expression.term.data_type === "datetime") &&
				expression.term.value.length > 0
			);
		case "date-add":
			return isGuaranteedTemporalValue(expression.date);
		case "date-coerce":
		case "datetime-coerce":
			return isGuaranteedTemporalValue(expression.value);
		case "if": {
			const condition = staticallyKnownPredicateBoolean(expression.cond);
			if (condition === true) return isGuaranteedTemporalValue(expression.then);
			if (condition === false)
				return isGuaranteedTemporalValue(expression.else);
			return (
				isGuaranteedTemporalValue(expression.then) &&
				isGuaranteedTemporalValue(expression.else)
			);
		}
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) return isGuaranteedTemporalValue(selected);
			return (
				expression.cases.every((entry) =>
					isGuaranteedTemporalValue(entry.then),
				) && isGuaranteedTemporalValue(expression.fallback)
			);
		}
		case "coalesce":
			return expression.values.some(isGuaranteedTemporalValue);
		case "double":
		case "arith":
		case "concat":
		case "count":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "format-date":
		case "table-lookup":
			return false;
		default:
			return false;
	}
}

function agreedStaticString(
	values: readonly (string | undefined)[],
): string | undefined {
	if (values.length === 0 || values.some((value) => value === undefined)) {
		return undefined;
	}
	const first = values[0] as string;
	return values.every((value) => value === first) ? first : undefined;
}

function isPropertyExpression(expression: Expression): boolean {
	return expression.kind === "term" && expression.term.kind === "prop";
}

/**
 * Detect one operator whose operands require candidate values from different
 * case rows. Relation-property normalization cannot make that scalar
 * comparison faithful: wrapping one read in `exists` changes the other read's
 * scope, while nesting two envelopes lets two unrelated rows satisfy each
 * half. CSQL also forbids a property Step on the value side.
 */
function hasMultiplePropertyScopes(
	expressions: readonly Expression[],
): boolean {
	const scopes = new Set<string>();
	for (const expression of expressions) {
		collectPropertyScopesFromExpression(expression, scopes);
		if (scopes.size > 1) return true;
	}
	return false;
}

function collectPropertyScopesFromExpression(
	expression: Expression,
	out: Set<string>,
): void {
	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "prop") {
				const via = expression.term.via;
				out.add(
					via === undefined || via.kind === "self"
						? `self:${expression.term.caseType}`
						: `via:${JSON.stringify(via)}`,
				);
			}
			return;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-add":
			collectPropertyScopesFromExpression(expression.date, out);
			collectPropertyScopesFromExpression(expression.quantity, out);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			collectPropertyScopesFromExpression(expression.value, out);
			return;
		case "arith":
			collectPropertyScopesFromExpression(expression.left, out);
			collectPropertyScopesFromExpression(expression.right, out);
			return;
		case "concat":
			for (const part of expression.parts) {
				collectPropertyScopesFromExpression(part, out);
			}
			return;
		case "coalesce":
			for (const value of expression.values) {
				collectPropertyScopesFromExpression(value, out);
			}
			return;
		case "if":
			collectPropertyScopesFromPredicate(expression.cond, out);
			collectPropertyScopesFromExpression(expression.then, out);
			collectPropertyScopesFromExpression(expression.else, out);
			return;
		case "switch":
			collectPropertyScopesFromExpression(expression.on, out);
			for (const entry of expression.cases) {
				collectPropertyScopesFromExpression(entry.then, out);
			}
			collectPropertyScopesFromExpression(expression.fallback, out);
			return;
		case "count":
			if (expression.where !== undefined) {
				collectPropertyScopesFromPredicate(expression.where, out);
			}
			return;
		case "table-lookup":
			collectPropertyScopesFromPredicate(expression.where, out);
			return;
		case "format-date":
			collectPropertyScopesFromExpression(expression.date, out);
			return;
		default:
			return;
	}
}

function collectPropertyScopesFromPredicate(
	predicate: Expression,
	out: Set<string>,
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			collectPropertyScopesFromExpression(predicate.left, out);
			collectPropertyScopesFromExpression(predicate.right, out);
			return;
		case "in":
		case "is-blank":
		case "matches-pattern":
			collectPropertyScopesFromExpression(predicate.left, out);
			return;
		case "between":
			collectPropertyScopesFromExpression(predicate.left, out);
			if (predicate.lower !== undefined)
				collectPropertyScopesFromExpression(predicate.lower, out);
			if (predicate.upper !== undefined)
				collectPropertyScopesFromExpression(predicate.upper, out);
			return;
		case "match":
			collectPropertyScopesFromExpression(
				predicate.property.kind === "prop"
					? { kind: "term", term: predicate.property }
					: predicate.property,
				out,
			);
			collectPropertyScopesFromExpression(predicate.value, out);
			return;
		case "multi-select-contains":
			collectPropertyScopesFromExpression(
				predicate.property.kind === "prop"
					? { kind: "term", term: predicate.property }
					: predicate.property,
				out,
			);
			return;
		case "within-distance":
			collectPropertyScopesFromExpression(
				{ kind: "term", term: predicate.property },
				out,
			);
			collectPropertyScopesFromExpression(predicate.center, out);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				collectPropertyScopesFromPredicate(clause, out);
			}
			return;
		case "not":
			collectPropertyScopesFromPredicate(predicate.clause, out);
			return;
		case "when-input-present":
			collectPropertyScopesFromPredicate(predicate.clause, out);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				collectPropertyScopesFromPredicate(predicate.where, out);
			}
			return;
		default:
			return;
	}
}

function literalValue(value: Expression | Term): Literal["value"] {
	if (value.kind !== "literal")
		throw new Error(
			"CSQL fixed values must be materialized literals before representability checks.",
		);
	return value.value;
}
