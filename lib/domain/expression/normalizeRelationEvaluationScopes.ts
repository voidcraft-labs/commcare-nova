/** Give each boolean leaf one case-row scope before any target lowers it. */
import type { CaseType } from "../blueprint";
import { type ExpressionNode, expressionChildren } from "./children";
import { mapExpressionChildren } from "./mapAst";
import { resolveRelationDestination } from "./relationDestination";
import {
	type Expression,
	type ExpressionOfKind,
	isConditionArm,
	isExpression,
	isRelationPath,
	type PropertyRef,
	type RelationPath,
} from "./types";
export type RelationEvaluationScopeIssue =
	| "mixed-property-scopes"
	| "unrebasable-relation-scope";
export class RelationEvaluationScopeError extends Error {
	readonly reason: RelationEvaluationScopeIssue;
	constructor(reason: RelationEvaluationScopeIssue, detail: string) {
		super(`Cannot evaluate this relationship condition: ${detail}`);
		this.name = "RelationEvaluationScopeError";
		this.reason = reason;
	}
}
export interface RelationEvaluationScopeContext {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType?: string;
}
/** A target may carry identity-keyed bindings across domain normalization. */
export type ExpressionReplacementObserver = (
	original: Expression,
	normalized: Expression,
) => void;
export interface CanonicalRelationPath {
	readonly via: RelationPath;
	readonly destinationCaseType?: string;
}
export function canonicalizeRelationPath(
	via: RelationPath,
	context: RelationEvaluationScopeContext,
): CanonicalRelationPath {
	if (via.kind === "self")
		return {
			via,
			...(context.currentCaseType === undefined
				? {}
				: { destinationCaseType: context.currentCaseType }),
		};
	const resolved = resolveRelationDestination(
		via,
		context.currentCaseType,
		context.caseTypes,
	);
	if (!resolved.ok)
		throw new RelationEvaluationScopeError(
			"unrebasable-relation-scope",
			resolved.message,
		);
	const destinationCaseType = resolved.caseType;
	if (via.kind === "ancestor") {
		let origin = context.currentCaseType;
		let changed = false;
		const steps = via.via.map((step) => {
			const hop = resolveRelationDestination(
				{ kind: "ancestor", via: [step] },
				origin,
				context.caseTypes,
			);
			if (!hop.ok)
				throw new RelationEvaluationScopeError(
					"unrebasable-relation-scope",
					hop.message,
				);
			origin = hop.caseType;
			if (step.throughCaseType !== undefined) return step;
			changed = true;
			return { ...step, throughCaseType: hop.caseType };
		}) as typeof via.via;
		return {
			via: changed ? { kind: "ancestor", via: steps } : via,
			destinationCaseType,
		};
	}
	if (via.kind === "any-relation" && context.currentCaseType !== undefined) {
		const origin = context.caseTypes.find(
			(t) => t.name === context.currentCaseType,
		);
		// Parent is the domain's declared relation. Other identifiers keep their explicit direction union.
		if (via.identifier === "parent") {
			const parent = origin?.parent_type === destinationCaseType;
			const child = context.caseTypes.some(
				(t) =>
					t.name === destinationCaseType &&
					t.parent_type === context.currentCaseType,
			);
			if (parent !== child)
				return {
					via: parent
						? {
								kind: "ancestor",
								via: [
									{
										identifier: via.identifier,
										throughCaseType: destinationCaseType,
									},
								],
							}
						: {
								kind: "subcase",
								identifier: via.identifier,
								ofCaseType: destinationCaseType,
							},
					destinationCaseType,
				};
		}
	}
	return {
		via:
			via.ofCaseType === undefined
				? { ...via, ofCaseType: destinationCaseType }
				: via,
		destinationCaseType,
	};
}
function relationContext(
	context: RelationEvaluationScopeContext,
	relation: CanonicalRelationPath,
): RelationEvaluationScopeContext {
	return {
		caseTypes: context.caseTypes,
		...(relation.destinationCaseType === undefined
			? {}
			: { currentCaseType: relation.destinationCaseType }),
	};
}
function localContext(
	context: RelationEvaluationScopeContext,
): RelationEvaluationScopeContext {
	return { caseTypes: context.caseTypes };
}
function rowBoundary(node: ExpressionNode): boolean {
	return (
		node.kind === "cases" ||
		node.kind === "table-rows" ||
		node.kind === "locations"
	);
}
function formBoundary(node: ExpressionNode): boolean {
	return (
		node.kind === "field" ||
		node.kind === "form-node" ||
		node.kind === "repeat-row"
	);
}
/** Scalar roots remain scalar; only boolean tests acquire existential envelopes. */
export function normalizeRelationEvaluationScopes(
	expression: Expression,
	context: RelationEvaluationScopeContext,
	onReplacement?: ExpressionReplacementObserver,
): Expression {
	const normalized = normalizeEvaluationScopes(
		expression,
		context,
		onReplacement,
	);
	if (normalized !== expression) onReplacement?.(expression, normalized);
	return normalized;
}
function normalizeEvaluationScopes(
	expression: Expression,
	context: RelationEvaluationScopeContext,
	onReplacement: ExpressionReplacementObserver | undefined,
): Expression {
	if (
		expression.kind === "exists" ||
		expression.kind === "missing" ||
		(expression.kind === "count" && isRelationPath(expression.via))
	) {
		const relation = canonicalizeRelationPath(
			expression.via as RelationPath,
			context,
		);
		const where =
			expression.where === undefined
				? undefined
				: normalizeRelationEvaluationScopes(
						expression.where,
						relationContext(context, relation),
						onReplacement,
					);
		if (relation.via === expression.via && where === expression.where)
			return expression;
		return {
			...expression,
			via: relation.via,
			...(where === undefined ? {} : { where }),
		};
	}
	const normalized = normalizeChildren(expression, context, onReplacement);
	if (!isConditionArm(normalized)) return normalized;
	switch (normalized.kind) {
		case "and":
		case "or":
		case "not":
		case "when-input-present":
		case "match-all":
		case "match-none":
			return normalized;
		case "between":
			return normalizeBetween(normalized, context, onReplacement);
		default:
			return normalizeLeaf(normalized, context, onReplacement);
	}
}
function normalizeChildren<T extends ExpressionNode>(
	node: T,
	context: RelationEvaluationScopeContext,
	onReplacement: ExpressionReplacementObserver | undefined,
): T {
	return mapExpressionChildren(node, (child) => {
		if (child.kind === "relation") return child.value;
		let next = context;
		if (
			rowBoundary(node) ||
			formBoundary(node) ||
			(node.kind === "project" &&
				child.role.kind === "operand" &&
				child.role.slot === "value")
		)
			next = localContext(context);
		if (child.kind === "term")
			return normalizeChildren(child.value, next, onReplacement);
		return normalizeRelationEvaluationScopes(child.value, next, onReplacement);
	});
}
interface ScopeInspection {
	related: Map<
		string,
		{ via: Exclude<RelationPath, { kind: "self" }>; destination: string }
	>;
	self: number;
	anchor: boolean;
}
function propertyScope(
	property: PropertyRef,
	context: RelationEvaluationScopeContext,
):
	| {
			key: string;
			via: Exclude<RelationPath, { kind: "self" }>;
			destination: string;
	  }
	| undefined {
	if (property.via === undefined || property.via.kind === "self")
		return undefined;
	const relation = canonicalizeRelationPath(property.via, {
		...context,
		currentCaseType: property.caseType ?? context.currentCaseType,
	});
	if (
		relation.via.kind === "self" ||
		relation.destinationCaseType === undefined
	)
		throw new RelationEvaluationScopeError(
			"unrebasable-relation-scope",
			"the related record type is missing.",
		);
	return {
		key: JSON.stringify(relation.via),
		via: relation.via,
		destination: relation.destinationCaseType,
	};
}
function inspect(
	node: ExpressionNode,
	context: RelationEvaluationScopeContext,
	inspection: ScopeInspection,
): void {
	if (formBoundary(node) || rowBoundary(node)) return;
	if (
		node.kind === "exists" ||
		node.kind === "missing" ||
		(node.kind === "count" && isRelationPath(node.via))
	) {
		inspection.anchor = true;
		return;
	}
	if (node.kind === "prop") {
		const scope = propertyScope(node, context);
		if (scope === undefined) inspection.self++;
		else inspection.related.set(scope.key, scope);
		return;
	}
	if (node.kind === "case-index" || node.kind === "case-row-type") {
		inspection.self++;
		return;
	}
	for (const child of expressionChildren(node)) {
		if (child.kind === "relation") continue;
		if (
			node.kind === "project" &&
			child.role.kind === "operand" &&
			child.role.slot === "value"
		)
			continue;
		inspect(child.value, context, inspection);
	}
}
function inspectionFor(
	expression: Expression,
	context: RelationEvaluationScopeContext,
): ScopeInspection {
	const result: ScopeInspection = {
		related: new Map(),
		self: 0,
		anchor: false,
	};
	inspect(expression, context, result);
	return result;
}
function rebase<T extends ExpressionNode>(
	node: T,
	key: string,
	context: RelationEvaluationScopeContext,
	onReplacement: ExpressionReplacementObserver | undefined,
): T {
	if (
		formBoundary(node) ||
		rowBoundary(node) ||
		node.kind === "exists" ||
		node.kind === "missing" ||
		(node.kind === "count" && isRelationPath(node.via))
	)
		return node;
	if (node.kind === "prop") {
		const scope = propertyScope(node, context);
		if (scope?.key === key)
			return {
				kind: "prop",
				caseType: scope.destination,
				property: node.property,
			} as T;
		return node;
	}
	const rebased = mapExpressionChildren(node, (child) => {
		if (child.kind === "relation") return child.value;
		if (
			node.kind === "project" &&
			child.role.kind === "operand" &&
			child.role.slot === "value"
		)
			return child.value;
		return rebase(child.value, key, context, onReplacement);
	});
	if (rebased !== node && isExpression(node) && isExpression(rebased))
		onReplacement?.(node, rebased);
	return rebased;
}
function normalizeLeaf(
	expression: Expression,
	context: RelationEvaluationScopeContext,
	onReplacement: ExpressionReplacementObserver | undefined,
): Expression {
	const inspection = inspectionFor(expression, context);
	if (inspection.related.size === 0) return expression;
	if (inspection.self > 0 || inspection.related.size > 1)
		throw new RelationEvaluationScopeError(
			"mixed-property-scopes",
			`"${expression.kind}" reads properties from more than one record scope. Put each relationship test in its own condition.`,
		);
	if (inspection.anchor)
		throw new RelationEvaluationScopeError(
			"unrebasable-relation-scope",
			`"${expression.kind}" combines a related property with another relationship count or condition. Put the relationship outside the value expression.`,
		);
	const [[key, scope]] = inspection.related;
	return {
		kind: "exists",
		via: scope.via,
		where: rebase(expression, key, context, onReplacement),
	};
}
function normalizeBetween(
	expression: ExpressionOfKind<"between">,
	context: RelationEvaluationScopeContext,
	onReplacement: ExpressionReplacementObserver | undefined,
): Expression {
	const lower: Expression | undefined =
		expression.lower === undefined
			? undefined
			: {
					kind: expression.lowerInclusive ? "gte" : "gt",
					left: expression.left,
					right: expression.lower,
				};
	const upper: Expression | undefined =
		expression.upper === undefined
			? undefined
			: {
					kind: expression.upperInclusive ? "lte" : "lt",
					left: expression.left,
					right: expression.upper,
				};
	if (lower === undefined && upper === undefined)
		throw new Error("Cannot evaluate a range without a bound.");
	if (
		(lower === undefined || inspectionFor(lower, context).related.size === 0) &&
		(upper === undefined || inspectionFor(upper, context).related.size === 0)
	)
		return expression;
	const left =
		lower === undefined
			? undefined
			: normalizeLeaf(lower, context, onReplacement);
	const right =
		upper === undefined
			? undefined
			: normalizeLeaf(upper, context, onReplacement);
	if (left !== undefined && right !== undefined)
		return { kind: "and", clauses: [left, right] };
	return left ?? right ?? expression;
}
