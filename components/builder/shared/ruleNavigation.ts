// Mutually recursive navigation for the Predicate and ValueExpression ASTs.
// The focus path deliberately matches the type checker's EditorPath so one
// location drives navigation, exact replacement, and inline diagnostics.

import type { CaseType } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	absenceSubjectConstraint,
	arithOperandConstraint,
	betweenBoundConstraint,
	betweenSubjectConstraint,
	branchConstraint,
	checkExpression,
	coerceOperandConstraint,
	comparisonObjectConstraint,
	comparisonSubjectConstraint,
	concatPartConstraint,
	dateAddOperandConstraint,
	dateOperandConstraint,
	doubleOperandConstraint,
	inSubjectConstraint,
	matchValueConstraint,
	numericConstraint,
	type Predicate,
	type SearchInputDecl,
	type SlotConstraint,
	textShapedConstraint,
	type ValueExpression,
	withinCenterConstraint,
} from "@/lib/domain/predicate";
import type { EditorPath } from "./path";
import { resolveRelationDestination } from "./relationDestination";

export interface RuleNavigationContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
}

export type EditableRuleNode =
	| { readonly family: "predicate"; readonly value: Predicate }
	| { readonly family: "expression"; readonly value: ValueExpression };

export interface LocatedRuleNode {
	readonly node: EditableRuleNode;
	readonly path: EditorPath;
	readonly currentCaseType: string;
	readonly constraint: SlotConstraint;
	readonly presentation: "value" | "subject";
	readonly breadcrumb: string;
}

export interface RuleLocation extends LocatedRuleNode {
	readonly trail: readonly LocatedRuleNode[];
}

function withoutDirectLiteralConstraint(
	constraint: SlotConstraint,
): SlotConstraint {
	if (constraint.forbidDirectLiteral !== true) return constraint;
	const { forbidDirectLiteral: _forbidDirectLiteral, ...rest } = constraint;
	return rest;
}

function typeAt(
	value: ValueExpression,
	currentCaseType: string,
	ctx: RuleNavigationContext,
) {
	return checkExpression(
		value,
		{
			caseTypes: [...ctx.caseTypes],
			knownInputs: [...ctx.knownInputs],
			currentCaseType,
		},
		[],
		[],
	);
}

function predicateLocation(
	value: Predicate,
	path: EditorPath,
	currentCaseType: string,
	breadcrumb: string,
): LocatedRuleNode {
	return {
		node: { family: "predicate", value },
		path,
		currentCaseType,
		constraint: ANY_CONSTRAINT,
		presentation: "value",
		breadcrumb,
	};
}

function expressionLocation(
	value: ValueExpression,
	path: EditorPath,
	currentCaseType: string,
	constraint: SlotConstraint,
	presentation: "value" | "subject",
	breadcrumb: string,
): LocatedRuleNode {
	return {
		node: { family: "expression", value },
		path,
		currentCaseType,
		constraint,
		presentation,
		breadcrumb,
	};
}

function locatePredicate(
	value: Predicate,
	path: EditorPath,
	remaining: EditorPath,
	currentCaseType: string,
	ctx: RuleNavigationContext,
	trail: readonly LocatedRuleNode[],
	breadcrumb: string,
): readonly LocatedRuleNode[] | undefined {
	const current = predicateLocation(value, path, currentCaseType, breadcrumb);
	const nextTrail = [...trail, current];
	if (remaining.length === 0) return nextTrail;

	const [first, second, ...rest] = remaining;
	const descendPredicate = (
		child: Predicate | undefined,
		consumed: EditorPath,
		childRemaining: EditorPath,
		childCaseType = currentCaseType,
		childBreadcrumb = "Condition",
	) =>
		child === undefined
			? undefined
			: locatePredicate(
					child,
					[...path, ...consumed],
					childRemaining,
					childCaseType,
					ctx,
					nextTrail,
					childBreadcrumb,
				);
	const descendExpression = (
		child: ValueExpression | undefined,
		consumed: EditorPath,
		childRemaining: EditorPath,
		constraint: SlotConstraint,
		presentation: "value" | "subject",
		childBreadcrumb: string,
	) =>
		child === undefined
			? undefined
			: locateExpression(
					child,
					[...path, ...consumed],
					childRemaining,
					currentCaseType,
					ctx,
					nextTrail,
					constraint,
					presentation,
					childBreadcrumb,
				);

	switch (value.kind) {
		case "and":
		case "or":
			return first === value.kind && typeof second === "number"
				? descendPredicate(
						value.clauses[second],
						[first, second],
						rest,
						currentCaseType,
						"Condition",
					)
				: undefined;
		case "not":
		case "when-input-present":
			return first === value.kind && second === "clause"
				? descendPredicate(
						value.clause,
						[first, second],
						rest,
						currentCaseType,
						value.kind === "not" ? "Excluded condition" : "Search condition",
					)
				: undefined;
		case "exists":
		case "missing": {
			if (first !== value.kind || second !== "where") return undefined;
			const destination = resolveRelationDestination(
				value.via,
				currentCaseType,
				ctx.caseTypes,
			);
			return destination === undefined
				? undefined
				: descendPredicate(
						value.where,
						[first, second],
						rest,
						destination,
						"Related cases",
					);
		}
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			if (first === "left") {
				return descendExpression(
					value.left,
					[first],
					remaining.slice(1),
					comparisonSubjectConstraint(value.kind),
					"subject",
					"Case information",
				);
			}
			if (first === "right") {
				return descendExpression(
					value.right,
					[first],
					remaining.slice(1),
					comparisonObjectConstraint(
						value.kind,
						typeAt(value.left, currentCaseType, ctx),
					),
					"value",
					"Compared value",
				);
			}
			return undefined;
		case "in":
			return first === "left"
				? descendExpression(
						value.left,
						[first],
						remaining.slice(1),
						inSubjectConstraint(),
						"subject",
						"Case information",
					)
				: undefined;
		case "between": {
			if (first === "left") {
				return descendExpression(
					value.left,
					[first],
					remaining.slice(1),
					betweenSubjectConstraint(),
					"subject",
					"Case information",
				);
			}
			const boundConstraint = betweenBoundConstraint(
				typeAt(value.left, currentCaseType, ctx),
			);
			if (first === "lower") {
				return descendExpression(
					value.lower,
					[first],
					remaining.slice(1),
					boundConstraint,
					"value",
					"Starting value",
				);
			}
			if (first === "upper") {
				return descendExpression(
					value.upper,
					[first],
					remaining.slice(1),
					boundConstraint,
					"value",
					"Ending value",
				);
			}
			return undefined;
		}
		case "is-null":
		case "is-blank":
			return first === "left"
				? descendExpression(
						value.left,
						[first],
						remaining.slice(1),
						absenceSubjectConstraint(),
						"subject",
						"Case information",
					)
				: undefined;
		case "match":
			return first === "value"
				? descendExpression(
						value.value,
						[first],
						remaining.slice(1),
						matchValueConstraint(value.mode),
						"value",
						"Value to match",
					)
				: undefined;
		case "within-distance":
			return first === "center"
				? descendExpression(
						value.center,
						[first],
						remaining.slice(1),
						withinCenterConstraint(),
						"value",
						"Center point",
					)
				: undefined;
		case "multi-select-contains":
		case "match-all":
		case "match-none":
			return undefined;
	}
}

function locateExpression(
	value: ValueExpression,
	path: EditorPath,
	remaining: EditorPath,
	currentCaseType: string,
	ctx: RuleNavigationContext,
	trail: readonly LocatedRuleNode[],
	constraint: SlotConstraint,
	presentation: "value" | "subject",
	breadcrumb: string,
): readonly LocatedRuleNode[] | undefined {
	const current = expressionLocation(
		value,
		path,
		currentCaseType,
		constraint,
		presentation,
		breadcrumb,
	);
	const nextTrail = [...trail, current];
	if (remaining.length === 0) return nextTrail;

	const [first, second, third, fourth] = remaining;
	const childConstraint = withoutDirectLiteralConstraint(constraint);
	const descendExpression = (
		child: ValueExpression | undefined,
		consumed: EditorPath,
		childRemaining: EditorPath,
		childSlotConstraint: SlotConstraint,
		childBreadcrumb: string,
	) =>
		child === undefined
			? undefined
			: locateExpression(
					child,
					[...path, ...consumed],
					childRemaining,
					currentCaseType,
					ctx,
					nextTrail,
					childSlotConstraint,
					"value",
					childBreadcrumb,
				);
	const descendPredicate = (
		child: Predicate | undefined,
		consumed: EditorPath,
		childRemaining: EditorPath,
		childCaseType = currentCaseType,
		childBreadcrumb = "Condition",
	) =>
		child === undefined
			? undefined
			: locatePredicate(
					child,
					[...path, ...consumed],
					childRemaining,
					childCaseType,
					ctx,
					nextTrail,
					childBreadcrumb,
				);

	switch (value.kind) {
		case "term":
		case "today":
		case "now":
			return undefined;
		case "date-add":
			if (first === "date") {
				return descendExpression(
					value.date,
					[first],
					remaining.slice(1),
					dateAddOperandConstraint(childConstraint),
					"Date",
				);
			}
			return first === "quantity"
				? descendExpression(
						value.quantity,
						[first],
						remaining.slice(1),
						numericConstraint(),
						"Amount",
					)
				: undefined;
		case "date-coerce":
		case "datetime-coerce":
			return first === "value"
				? descendExpression(
						value.value,
						[first],
						remaining.slice(1),
						coerceOperandConstraint(),
						"Source value",
					)
				: undefined;
		case "double":
			return first === "value"
				? descendExpression(
						value.value,
						[first],
						remaining.slice(1),
						doubleOperandConstraint(),
						"Source value",
					)
				: undefined;
		case "arith":
			if (first === "left") {
				return descendExpression(
					value.left,
					[first],
					remaining.slice(1),
					arithOperandConstraint(),
					"First number",
				);
			}
			return first === "right"
				? descendExpression(
						value.right,
						[first],
						remaining.slice(1),
						arithOperandConstraint(),
						"Second number",
					)
				: undefined;
		case "concat":
			return first === "parts" && typeof second === "number"
				? descendExpression(
						value.parts[second],
						[first, second],
						remaining.slice(2),
						concatPartConstraint(),
						"Text part",
					)
				: undefined;
		case "coalesce":
			return first === "values" && typeof second === "number"
				? descendExpression(
						value.values[second],
						[first, second],
						remaining.slice(2),
						branchConstraint(
							childConstraint,
							...value.values
								.filter((_, index) => index !== second)
								.map((item) => typeAt(item, currentCaseType, ctx)),
						),
						"Fallback value",
					)
				: undefined;
		case "if":
			if (first !== "if") return undefined;
			if (second === "cond") {
				return descendPredicate(
					value.cond,
					[first, second],
					remaining.slice(2),
					currentCaseType,
					"When",
				);
			}
			if (second === "then") {
				return descendExpression(
					value.then,
					[first, second],
					remaining.slice(2),
					branchConstraint(
						childConstraint,
						typeAt(value.else, currentCaseType, ctx),
					),
					"Use this value",
				);
			}
			return second === "else"
				? descendExpression(
						value.else,
						[first, second],
						remaining.slice(2),
						branchConstraint(
							childConstraint,
							typeAt(value.then, currentCaseType, ctx),
						),
						"Otherwise",
					)
				: undefined;
		case "switch":
			if (first !== "switch") return undefined;
			if (second === "on") {
				return descendExpression(
					value.on,
					[first, second],
					remaining.slice(2),
					ANY_CONSTRAINT,
					"Value to match",
				);
			}
			if (second === "fallback") {
				return descendExpression(
					value.fallback,
					[first, second],
					remaining.slice(2),
					branchConstraint(
						childConstraint,
						...value.cases.map((item) =>
							typeAt(item.then, currentCaseType, ctx),
						),
					),
					"Fallback value",
				);
			}
			return second === "cases" &&
				typeof third === "number" &&
				fourth === "then"
				? descendExpression(
						value.cases[third]?.then,
						[first, second, third, fourth],
						remaining.slice(4),
						branchConstraint(
							childConstraint,
							typeAt(value.fallback, currentCaseType, ctx),
							...value.cases
								.filter((_, index) => index !== third)
								.map((item) => typeAt(item.then, currentCaseType, ctx)),
						),
						"Matching value",
					)
				: undefined;
		case "count": {
			if (first !== "count" || second !== "where") return undefined;
			const destination = resolveRelationDestination(
				value.via,
				currentCaseType,
				ctx.caseTypes,
			);
			return destination === undefined
				? undefined
				: descendPredicate(
						value.where,
						[first, second],
						remaining.slice(2),
						destination,
						"Related cases",
					);
		}
		case "unwrap-list":
			return first === "value"
				? descendExpression(
						value.value,
						[first],
						remaining.slice(1),
						textShapedConstraint(),
						"Saved list",
					)
				: undefined;
		case "format-date":
			return first === "date"
				? descendExpression(
						value.date,
						[first],
						remaining.slice(1),
						dateOperandConstraint(),
						"Date",
					)
				: undefined;
	}
}

export function locateRuleNode(
	root: Predicate,
	path: EditorPath,
	ctx: RuleNavigationContext,
): RuleLocation | undefined {
	const trail = locatePredicate(
		root,
		[],
		path,
		ctx.currentCaseType,
		ctx,
		[],
		"Cases available",
	);
	if (trail === undefined) return undefined;
	const last = trail.at(-1);
	return last === undefined ? undefined : { ...last, trail };
}

export function nearestRuleLocation(
	root: Predicate,
	requestedPath: EditorPath,
	ctx: RuleNavigationContext,
): RuleLocation {
	let candidate = requestedPath;
	while (candidate.length > 0) {
		const found = locateRuleNode(root, candidate, ctx);
		if (found !== undefined) return found;
		candidate = candidate.slice(0, -1);
	}
	const rootLocation = locateRuleNode(root, [], ctx);
	if (rootLocation === undefined) {
		throw new Error("Could not locate the root condition");
	}
	return rootLocation;
}

function replacementAtTarget(
	next: EditableRuleNode,
	family: EditableRuleNode["family"],
) {
	if (next.family !== family) {
		throw new Error(`Cannot replace a ${family} with a ${next.family}`);
	}
	return next.value;
}

function replacePredicate(
	value: Predicate,
	path: EditorPath,
	next: EditableRuleNode,
): Predicate {
	if (path.length === 0) {
		return replacementAtTarget(next, "predicate") as Predicate;
	}
	const [first, second] = path;
	const replacePredicateChild = (child: Predicate, consumed: number) =>
		replacePredicate(child, path.slice(consumed), next);
	const replaceExpressionChild = (child: ValueExpression, consumed: number) =>
		replaceExpression(child, path.slice(consumed), next);

	switch (value.kind) {
		case "and":
		case "or": {
			if (
				first !== value.kind ||
				typeof second !== "number" ||
				value.clauses[second] === undefined
			) {
				break;
			}
			const clauses = value.clauses.map((clause, index) =>
				index === second ? replacePredicateChild(clause, 2) : clause,
			) as [Predicate, ...Predicate[]];
			return { ...value, clauses };
		}
		case "not":
		case "when-input-present":
			if (first === value.kind && second === "clause") {
				return {
					...value,
					clause: replacePredicateChild(value.clause, 2),
				};
			}
			break;
		case "exists":
		case "missing":
			if (
				first === value.kind &&
				second === "where" &&
				value.where !== undefined
			) {
				return {
					...value,
					where: replacePredicateChild(value.where, 2),
				};
			}
			break;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			if (first === "left") {
				return { ...value, left: replaceExpressionChild(value.left, 1) };
			}
			if (first === "right") {
				return { ...value, right: replaceExpressionChild(value.right, 1) };
			}
			break;
		case "in":
		case "is-null":
		case "is-blank":
			if (first === "left") {
				return { ...value, left: replaceExpressionChild(value.left, 1) };
			}
			break;
		case "between":
			if (first === "left") {
				return { ...value, left: replaceExpressionChild(value.left, 1) };
			}
			if (first === "lower" && value.lower !== undefined) {
				return { ...value, lower: replaceExpressionChild(value.lower, 1) };
			}
			if (first === "upper" && value.upper !== undefined) {
				return { ...value, upper: replaceExpressionChild(value.upper, 1) };
			}
			break;
		case "match":
			if (first === "value") {
				return { ...value, value: replaceExpressionChild(value.value, 1) };
			}
			break;
		case "within-distance":
			if (first === "center") {
				return { ...value, center: replaceExpressionChild(value.center, 1) };
			}
			break;
		case "multi-select-contains":
		case "match-all":
		case "match-none":
			break;
	}
	throw new Error("Condition path does not point to an editable node");
}

function replaceExpression(
	value: ValueExpression,
	path: EditorPath,
	next: EditableRuleNode,
): ValueExpression {
	if (path.length === 0) {
		return replacementAtTarget(next, "expression") as ValueExpression;
	}
	const [first, second, third, fourth] = path;
	const replaceExpressionChild = (child: ValueExpression, consumed: number) =>
		replaceExpression(child, path.slice(consumed), next);
	const replacePredicateChild = (child: Predicate, consumed: number) =>
		replacePredicate(child, path.slice(consumed), next);

	switch (value.kind) {
		case "term":
		case "today":
		case "now":
			break;
		case "date-add":
			if (first === "date") {
				return { ...value, date: replaceExpressionChild(value.date, 1) };
			}
			if (first === "quantity") {
				return {
					...value,
					quantity: replaceExpressionChild(value.quantity, 1),
				};
			}
			break;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			if (first === "value") {
				return { ...value, value: replaceExpressionChild(value.value, 1) };
			}
			break;
		case "arith":
			if (first === "left") {
				return { ...value, left: replaceExpressionChild(value.left, 1) };
			}
			if (first === "right") {
				return { ...value, right: replaceExpressionChild(value.right, 1) };
			}
			break;
		case "concat":
			if (
				first === "parts" &&
				typeof second === "number" &&
				value.parts[second] !== undefined
			) {
				const parts = value.parts.map((part, index) =>
					index === second ? replaceExpressionChild(part, 2) : part,
				) as [ValueExpression, ...ValueExpression[]];
				return { ...value, parts };
			}
			break;
		case "coalesce":
			if (
				first === "values" &&
				typeof second === "number" &&
				value.values[second] !== undefined
			) {
				const values = value.values.map((item, index) =>
					index === second ? replaceExpressionChild(item, 2) : item,
				) as [ValueExpression, ...ValueExpression[]];
				return { ...value, values };
			}
			break;
		case "if":
			if (first !== "if") break;
			if (second === "cond") {
				return { ...value, cond: replacePredicateChild(value.cond, 2) };
			}
			if (second === "then") {
				// biome-ignore lint/suspicious/noThenProperty: This is the persisted ValueExpression AST slot, not a thenable API.
				return { ...value, then: replaceExpressionChild(value.then, 2) };
			}
			if (second === "else") {
				return { ...value, else: replaceExpressionChild(value.else, 2) };
			}
			break;
		case "switch":
			if (first !== "switch") break;
			if (second === "on") {
				return { ...value, on: replaceExpressionChild(value.on, 2) };
			}
			if (second === "fallback") {
				return {
					...value,
					fallback: replaceExpressionChild(value.fallback, 2),
				};
			}
			if (
				second === "cases" &&
				typeof third === "number" &&
				fourth === "then" &&
				value.cases[third] !== undefined
			) {
				const cases = value.cases.map((item, index) =>
					index === third
						? // biome-ignore lint/suspicious/noThenProperty: This is the persisted SwitchCase AST slot, not a thenable API.
							{ ...item, then: replaceExpressionChild(item.then, 4) }
						: item,
				) as typeof value.cases;
				return { ...value, cases };
			}
			break;
		case "count":
			if (
				first === "count" &&
				second === "where" &&
				value.where !== undefined
			) {
				return { ...value, where: replacePredicateChild(value.where, 2) };
			}
			break;
		case "format-date":
			if (first === "date") {
				return { ...value, date: replaceExpressionChild(value.date, 1) };
			}
			break;
	}
	throw new Error("Value path does not point to an editable node");
}

/** Replace only the addressed Predicate or ValueExpression node. Every
 * untouched sibling keeps both its value and object identity. */
export function replaceRuleNodeAtPath(
	root: Predicate,
	path: EditorPath,
	next: EditableRuleNode,
): Predicate {
	return replacePredicate(root, path, next);
}
