// Navigation for condition and value presentations of the Expression AST.
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
	coerceOperandConstraint,
	comparisonObjectConstraint,
	comparisonSubjectConstraint,
	concatPartConstraint,
	dateAddOperandConstraint,
	dateOperandConstraint,
	doubleOperandConstraint,
	type Expression,
	type ExpressionContext,
	expressionContextAtPath,
	inSubjectConstraint,
	isRelationPath,
	mapExpressionAst,
	matchValueConstraint,
	numericConstraint,
	type SearchInputDecl,
	type SlotConstraint,
	scalarDataType,
	typeOf,
	withinCenterConstraint,
} from "@/lib/domain/expression";
import type { EditorPath } from "./path";
import { resolveRelationDestination } from "./relationDestination";

export interface RuleNavigationContext {
	readonly expressionContext: ExpressionContext;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	/** What the whole rule is called where it lives, used as the root
	 *  breadcrumb and the "back to" destination. Defaults to the case
	 *  list's own name for it. */
	readonly rootLabel?: string;
}

/** The root rule's name when the surface does not supply one. */
export const DEFAULT_RULE_ROOT_LABEL = "Cases available";

export type EditableRuleNode =
	| { readonly family: "predicate"; readonly value: Expression }
	| { readonly family: "expression"; readonly value: Expression };

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

interface RuleWalkContext extends RuleNavigationContext {
	readonly root: Expression;
}

function typeAt(value: Expression, path: EditorPath, ctx: RuleWalkContext) {
	const context = expressionContextAtPath(
		ctx.root,
		ctx.expressionContext,
		path,
	);
	return context === undefined
		? undefined
		: scalarDataType(typeOf(value, context)?.data);
}

function predicateLocation(
	value: Expression,
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
	value: Expression,
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
	value: Expression,
	path: EditorPath,
	remaining: EditorPath,
	currentCaseType: string,
	ctx: RuleWalkContext,
	trail: readonly LocatedRuleNode[],
	breadcrumb: string,
): readonly LocatedRuleNode[] | undefined {
	const current = predicateLocation(value, path, currentCaseType, breadcrumb);
	const nextTrail = [...trail, current];
	if (remaining.length === 0) return nextTrail;

	const [first, second, ...rest] = remaining;
	const descendPredicate = (
		child: Expression | undefined,
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
		child: Expression | undefined,
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
					comparisonObjectConstraint(value.kind, typeAt(value.left, path, ctx)),
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
				typeAt(value.left, path, ctx),
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
		case "is-blank":
		case "matches-pattern":
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
	value: Expression,
	path: EditorPath,
	remaining: EditorPath,
	currentCaseType: string,
	ctx: RuleWalkContext,
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
	const descendExpression = (
		child: Expression | undefined,
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
		child: Expression | undefined,
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
		case "id-of":
		case "acting-user":
		case "unowned":
		case "today":
		case "now":
			return undefined;
		case "date-add":
			if (first === "date") {
				return descendExpression(
					value.date,
					[first],
					remaining.slice(1),
					dateAddOperandConstraint(constraint),
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
		case "negate":
			return first === "negate" && second === "value"
				? descendExpression(
						value.value,
						[first, second],
						remaining.slice(2),
						numericConstraint(),
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
							constraint,
							...value.values
								.filter((_, index) => index !== second)
								.map((item) => typeAt(item, path, ctx)),
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
					branchConstraint(constraint, typeAt(value.else, path, ctx)),
					"Use this value",
				);
			}
			return second === "else"
				? descendExpression(
						value.else,
						[first, second],
						remaining.slice(2),
						branchConstraint(constraint, typeAt(value.then, path, ctx)),
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
						constraint,
						...value.cases.map((item) => typeAt(item.then, path, ctx)),
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
							constraint,
							typeAt(value.fallback, path, ctx),
							...value.cases
								.filter((_, index) => index !== third)
								.map((item) => typeAt(item.then, path, ctx)),
						),
						"Matching value",
					)
				: undefined;
		case "count": {
			if (first !== "count" || second !== "where" || !isRelationPath(value.via))
				return undefined;
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
		case "table-lookup":
			return first === "table-lookup" && second === "where"
				? descendPredicate(
						value.where,
						[first, second],
						remaining.slice(2),
						currentCaseType,
						"Matching table row",
					)
				: undefined;
	}
}

export function locateRuleNode(
	root: Expression,
	path: EditorPath,
	ctx: RuleNavigationContext,
): RuleLocation | undefined {
	const trail = locatePredicate(
		root,
		[],
		path,
		ctx.currentCaseType,
		{ ...ctx, root },
		[],
		ctx.rootLabel ?? DEFAULT_RULE_ROOT_LABEL,
	);
	if (trail === undefined) return undefined;
	const last = trail.at(-1);
	return last === undefined ? undefined : { ...last, trail };
}

export function nearestRuleLocation(
	root: Expression,
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

/** Presentation families select an editor, not a separate stored grammar. The
 * canonical edge table owns replacement paths for every Expression shape. */
function replaceNodeAtPath(
	root: Expression,
	path: EditorPath,
	next: Expression,
): Expression {
	let found = false;
	const result = mapExpressionAst(root, {
		mapExpression: (value, currentPath) => {
			if (
				currentPath.length !== path.length ||
				currentPath.some((segment, index) => segment !== path[index])
			)
				return value;
			found = true;
			return next;
		},
	});
	if (!found)
		throw new Error("Expression path does not point to an editable node");
	return result;
}

/** Replace one node inside a standalone Expression root. */
export function replaceExpressionNodeAtPath(
	root: Expression,
	path: EditorPath,
	next: EditableRuleNode,
): Expression {
	return replaceNodeAtPath(root, path, next.value);
}

/** Replace only the addressed Expression node. Every untouched sibling keeps
 * both its value and object identity. The slot checker owns type admission. */
export function replaceRuleNodeAtPath(
	root: Expression,
	path: EditorPath,
	next: EditableRuleNode,
): Expression {
	return replaceNodeAtPath(root, path, next.value);
}
