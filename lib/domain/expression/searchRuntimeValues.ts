/**
 * The values of a server search condition that a device works out before the
 * search runs. The server's search language evaluates a closed set of values
 * itself: a read, `today`, `now`, `date-coerce`, `datetime-coerce`, `double`
 * and `date-add` (CommCare HQ's
 * `corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`),
 * and a child-case count on a comparison's query side. Any other value (an
 * `if`, `coalesce`, `switch`, other count, arithmetic, `concat`,
 * `format-date`, …) is evaluated by Core on the device and its answer spliced
 * into the query (`lib/commcare/csql/emitter.ts::inlineAsRuntimeOperand`).
 *
 * The emitter, the CSQL validators and the checker all read these values here,
 * so none of them evaluates on a device what another sends to the server.
 */
import { expressionChildren } from "./children";
import type { ExpressionContext } from "./context";
import { expressionChildContext } from "./typeChecker";
import {
	type CheckPath,
	type Expression,
	isConditionArm,
	isRelationPath,
} from "./types";

/** A value the server's search language evaluates itself, its operands
 * evaluated the same way in turn. */
export function isServerSearchValue(expression: Expression): boolean {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "date-add":
			return true;
		default:
			return false;
	}
}

/** A comparison's query side: a case property, or a child-case count. The
 * search puts one authored on the right onto the left before it parses
 * (`lib/commcare/csql/representability.ts::normalizeCsqlPredicate`). */
function isQueryAnchor(expression: Expression): boolean {
	return (
		(expression.kind === "term" && expression.term.kind === "prop") ||
		(expression.kind === "count" &&
			isRelationPath(expression.via) &&
			expression.via.kind === "subcase")
	);
}

type Visit = (
	value: Expression,
	context: ExpressionContext,
	path: CheckPath,
) => void;

/**
 * Visit each value of a server search condition that a device evaluates, with
 * its lexical context and its path from `predicate`. A condition that is no
 * search clause is evaluated whole on a device.
 */
export function walkSearchRuntimeValues(
	predicate: Expression,
	context: ExpressionContext,
	visit: Visit,
): void {
	walkClause(predicate, context, [], visit);
}

function walkClause(
	predicate: Expression,
	context: ExpressionContext,
	path: CheckPath,
	visit: Visit,
): void {
	if (!isConditionArm(predicate)) {
		visit(predicate, context, path);
		return;
	}
	const swapped =
		(predicate.kind === "eq" ||
			predicate.kind === "neq" ||
			predicate.kind === "lt" ||
			predicate.kind === "lte" ||
			predicate.kind === "gt" ||
			predicate.kind === "gte") &&
		!isQueryAnchor(predicate.left) &&
		isQueryAnchor(predicate.right);
	for (const child of expressionChildren(predicate)) {
		if (child.kind !== "expression") continue;
		const childContext = expressionChildContext(predicate, child, context);
		const childPath = [...path, ...child.path];
		if (
			predicate.kind === "and" ||
			predicate.kind === "or" ||
			predicate.kind === "not" ||
			predicate.kind === "when-input-present" ||
			predicate.kind === "exists" ||
			predicate.kind === "missing"
		) {
			walkClause(child.value, childContext, childPath, visit);
			continue;
		}
		const querySide =
			child.role.kind === "operand" &&
			child.role.slot === (swapped ? "right" : "left");
		walkValue(child.value, querySide, childContext, childPath, visit);
	}
}

function walkValue(
	expression: Expression,
	querySide: boolean,
	context: ExpressionContext,
	path: CheckPath,
	visit: Visit,
): void {
	if (
		querySide &&
		expression.kind === "count" &&
		isRelationPath(expression.via) &&
		expression.via.kind === "subcase"
	) {
		for (const child of expressionChildren(expression))
			if (
				child.kind === "expression" &&
				child.role.kind === "operand" &&
				child.role.slot === "where"
			)
				walkClause(
					child.value,
					expressionChildContext(expression, child, context),
					[...path, ...child.path],
					visit,
				);
		return;
	}
	if (!isServerSearchValue(expression)) {
		visit(expression, context, path);
		return;
	}
	for (const child of expressionChildren(expression))
		if (child.kind === "expression")
			walkValue(
				child.value,
				false,
				expressionChildContext(expression, child, context),
				[...path, ...child.path],
				visit,
			);
}
