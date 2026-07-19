// lib/domain/predicate/normalizeRelationEvaluationScopes.ts
//
// JavaRosa scalar operators/functions cannot unpack a PropertyRef path that
// reaches more than one related case. Preview must share the same intentional
// meaning rather than choosing an arbitrary row. This pass lowers every leaf
// evaluation scope whose non-self PropertyRefs all share one relation R to:
//
//   exists(R, where: <same leaf with every R property rebased to self>)
//
// `between` is special: its lower and upper comparisons are independent, so
// each bound receives its own quantifier. Explicit authored exists/missing and
// count.where are scope boundaries. A leaf mixing self+R, R1+R2, or an outer
// relation read with an anchor-sensitive nested quantifier cannot be rebased
// faithfully and fails closed; the module validator surfaces the friendly
// authoring repair before a compiler reaches this defense.

import type { CaseType } from "../blueprint";
import { relationPropertyDestinationCaseType } from "./normalizeRelationReads";
import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationPath,
	SwitchCase,
	ValueExpression,
} from "./types";

export type RelationEvaluationScopeIssue =
	| "mixed-property-scopes"
	| "unrebasable-relation-scope";

export class RelationEvaluationScopeError extends Error {
	readonly reason: RelationEvaluationScopeIssue;

	constructor(reason: RelationEvaluationScopeIssue, detail: string) {
		super(`normalizeRelationEvaluationScopes [${reason}]: ${detail}`);
		this.name = "RelationEvaluationScopeError";
		this.reason = reason;
	}
}

export interface RelationEvaluationScopeContext {
	readonly caseTypes?: ReadonlyArray<CaseType>;
	/** Case type of the row against which this predicate/expression runs. */
	readonly currentCaseType?: string;
}

/** Normalize every predicate leaf reachable through structural boolean slots. */
export function normalizeRelationEvaluationScopes(
	predicate: Predicate,
	context: RelationEvaluationScopeContext = {},
): Predicate {
	switch (predicate.kind) {
		case "and":
		case "or": {
			const clauses = predicate.clauses.map((clause) =>
				normalizeRelationEvaluationScopes(clause, context),
			) as [Predicate, ...Predicate[]];
			return clauses.every(
				(clause, index) => clause === predicate.clauses[index],
			)
				? predicate
				: { ...predicate, clauses };
		}
		case "not": {
			const clause = normalizeRelationEvaluationScopes(
				predicate.clause,
				context,
			);
			return clause === predicate.clause ? predicate : { ...predicate, clause };
		}
		case "when-input-present": {
			const clause = normalizeRelationEvaluationScopes(
				predicate.clause,
				context,
			);
			return clause === predicate.clause ? predicate : { ...predicate, clause };
		}
		case "exists":
		case "missing": {
			return normalizeExplicitRelationBoundary(predicate, context);
		}
		case "between":
			return normalizeBetweenScopes(predicate, context);
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "is-null":
		case "is-blank":
		case "match":
		case "multi-select-contains":
		case "within-distance":
			return normalizeLeafScope(predicate, context);
		case "match-all":
		case "match-none":
			return predicate;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`normalizeRelationEvaluationScopes: unhandled Predicate kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function normalizeExplicitRelationBoundary(
	predicate: Extract<Predicate, { kind: "exists" | "missing" }>,
	context: RelationEvaluationScopeContext,
): Predicate {
	const relation = canonicalizeRelationPath(predicate.via, context);
	const whereContext = contextAtRelationDestination(context, relation);
	const where =
		predicate.where === undefined
			? undefined
			: normalizeRelationEvaluationScopes(predicate.where, whereContext);
	return relation.via === predicate.via && where === predicate.where
		? predicate
		: { ...predicate, via: relation.via, where };
}

function normalizeBetweenScopes(
	predicate: Extract<Predicate, { kind: "between" }>,
	context: RelationEvaluationScopeContext,
): Predicate {
	// `between` bounds may themselves contain independent predicate scopes
	// (`if.cond`, `count.where`). Normalize those boundaries before looking for
	// a relation on the comparison itself; otherwise a self-scoped range with a
	// related read nested inside `count.where` would incorrectly take the fast
	// path and leave that inner read unnormalized.
	const normalizedBoundaries = normalizeNestedBoundaryScopes(
		predicate,
		context,
	) as typeof predicate;
	const lower =
		normalizedBoundaries.lower === undefined
			? undefined
			: comparisonForBound(
					normalizedBoundaries.left,
					normalizedBoundaries.lowerInclusive ? "gte" : "gt",
					normalizedBoundaries.lower,
				);
	const upper =
		normalizedBoundaries.upper === undefined
			? undefined
			: comparisonForBound(
					normalizedBoundaries.left,
					normalizedBoundaries.upperInclusive ? "lte" : "lt",
					normalizedBoundaries.upper,
				);

	if (lower === undefined && upper === undefined) {
		throw new Error(
			"normalizeRelationEvaluationScopes: between reached normalization without either bound; the schema should reject this shape.",
		);
	}

	const lowerHasRelation =
		lower !== undefined &&
		inspectLeafScope(lower, context).relatedScopes.size > 0;
	const upperHasRelation =
		upper !== undefined &&
		inspectLeafScope(upper, context).relatedScopes.size > 0;
	if (!lowerHasRelation && !upperHasRelation) return normalizedBoundaries;

	const normalizedLower =
		lower === undefined ? undefined : normalizeLeafScope(lower, context);
	const normalizedUpper =
		upper === undefined ? undefined : normalizeLeafScope(upper, context);
	if (normalizedLower !== undefined && normalizedUpper !== undefined) {
		return { kind: "and", clauses: [normalizedLower, normalizedUpper] };
	}
	return normalizedLower ?? normalizedUpper ?? normalizedBoundaries;
}

function comparisonForBound(
	left: ValueExpression,
	kind: ComparisonKind,
	right: ValueExpression,
): Extract<Predicate, { kind: ComparisonKind }> {
	return { kind, left, right };
}

interface ScopeInspection {
	readonly relatedScopes: Map<
		string,
		{ readonly via: Exclude<RelationPath, { kind: "self" }> }
	>;
	selfPropertyCount: number;
	hasAnchorSensitiveBoundary: boolean;
}

function normalizeLeafScope(
	predicate: Exclude<
		Predicate,
		| { kind: "and" | "or" | "not" | "when-input-present" }
		| { kind: "exists" | "missing" | "between" }
		| { kind: "match-all" | "match-none" }
	>,
	context: RelationEvaluationScopeContext,
): Predicate {
	const normalizedBoundaries = normalizeNestedBoundaryScopes(
		predicate,
		context,
	) as typeof predicate;
	const inspection = inspectLeafScope(normalizedBoundaries, context);
	if (inspection.relatedScopes.size === 0) return normalizedBoundaries;
	if (inspection.selfPropertyCount > 0 || inspection.relatedScopes.size > 1) {
		throw new RelationEvaluationScopeError(
			"mixed-property-scopes",
			`'${normalizedBoundaries.kind}' reads case properties from more than one row scope. Put the cross-scope logic in an explicit supported relation shape or keep the operator on one case.`,
		);
	}
	if (inspection.hasAnchorSensitiveBoundary) {
		throw new RelationEvaluationScopeError(
			"unrebasable-relation-scope",
			`'${normalizedBoundaries.kind}' combines a related property read with an explicit relation/count scope. Wrapping the operator would re-anchor the nested walk. Move the quantifier outside the value expression.`,
		);
	}

	const [[scopeKey, scope]] = inspection.relatedScopes;
	const rebased = rebasePredicate(normalizedBoundaries, scopeKey, context);
	return { kind: "exists", via: scope.via, where: rebased };
}

/**
 * Normalize predicate scopes that sit behind an explicit evaluation boundary
 * inside a leaf ValueExpression. `if.cond`, authored `exists`/`missing`, and
 * `count.where` each have independent boolean semantics, so each normalizes in
 * its own scope. If a leaf also reads a related value outside one of those
 * boundaries, the outer inspection rejects the unrebasable combination rather
 * than silently coupling the independent condition to one related row.
 */
function normalizeNestedBoundaryScopes(
	predicate: Predicate,
	context: RelationEvaluationScopeContext,
): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const left = normalizeExpressionBoundaryScopes(predicate.left, context);
			const right = normalizeExpressionBoundaryScopes(predicate.right, context);
			return left === predicate.left && right === predicate.right
				? predicate
				: { ...predicate, left, right };
		}
		case "in":
		case "is-null":
		case "is-blank": {
			const left = normalizeExpressionBoundaryScopes(predicate.left, context);
			return left === predicate.left ? predicate : { ...predicate, left };
		}
		case "between": {
			const left = normalizeExpressionBoundaryScopes(predicate.left, context);
			const lower =
				predicate.lower === undefined
					? undefined
					: normalizeExpressionBoundaryScopes(predicate.lower, context);
			const upper =
				predicate.upper === undefined
					? undefined
					: normalizeExpressionBoundaryScopes(predicate.upper, context);
			return left === predicate.left &&
				lower === predicate.lower &&
				upper === predicate.upper
				? predicate
				: { ...predicate, left, lower, upper };
		}
		case "match": {
			const value = normalizeExpressionBoundaryScopes(predicate.value, context);
			return value === predicate.value ? predicate : { ...predicate, value };
		}
		case "within-distance": {
			const center = normalizeExpressionBoundaryScopes(
				predicate.center,
				context,
			);
			return center === predicate.center ? predicate : { ...predicate, center };
		}
		case "multi-select-contains":
			return predicate;
		case "and":
		case "or": {
			const clauses = predicate.clauses.map((clause) =>
				normalizeNestedBoundaryScopes(clause, context),
			) as [Predicate, ...Predicate[]];
			return clauses.every(
				(clause, index) => clause === predicate.clauses[index],
			)
				? predicate
				: { ...predicate, clauses };
		}
		case "not":
		case "when-input-present": {
			const clause = normalizeNestedBoundaryScopes(predicate.clause, context);
			return clause === predicate.clause ? predicate : { ...predicate, clause };
		}
		case "exists":
		case "missing": {
			return normalizeExplicitRelationBoundary(predicate, context);
		}
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`normalizeNestedBoundaryScopes: unhandled Predicate kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function normalizeExpressionBoundaryScopes(
	expression: ValueExpression,
	context: RelationEvaluationScopeContext,
): ValueExpression {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
			return expression;
		case "date-add": {
			const date = normalizeExpressionBoundaryScopes(expression.date, context);
			const quantity = normalizeExpressionBoundaryScopes(
				expression.quantity,
				context,
			);
			return date === expression.date && quantity === expression.quantity
				? expression
				: { ...expression, date, quantity };
		}
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list": {
			const value = normalizeExpressionBoundaryScopes(
				expression.value,
				context,
			);
			return value === expression.value ? expression : { ...expression, value };
		}
		case "format-date": {
			const date = normalizeExpressionBoundaryScopes(expression.date, context);
			return date === expression.date ? expression : { ...expression, date };
		}
		case "arith": {
			const left = normalizeExpressionBoundaryScopes(expression.left, context);
			const right = normalizeExpressionBoundaryScopes(
				expression.right,
				context,
			);
			return left === expression.left && right === expression.right
				? expression
				: { ...expression, left, right };
		}
		case "concat": {
			const parts = expression.parts.map((part) =>
				normalizeExpressionBoundaryScopes(part, context),
			) as [ValueExpression, ...ValueExpression[]];
			return parts.every((part, index) => part === expression.parts[index])
				? expression
				: { ...expression, parts };
		}
		case "coalesce": {
			const values = expression.values.map((value) =>
				normalizeExpressionBoundaryScopes(value, context),
			) as [ValueExpression, ...ValueExpression[]];
			return values.every((value, index) => value === expression.values[index])
				? expression
				: { ...expression, values };
		}
		case "if": {
			const cond = normalizeRelationEvaluationScopes(expression.cond, context);
			const thenValue = normalizeExpressionBoundaryScopes(
				expression.then,
				context,
			);
			const elseValue = normalizeExpressionBoundaryScopes(
				expression.else,
				context,
			);
			return cond === expression.cond &&
				thenValue === expression.then &&
				elseValue === expression.else
				? expression
				: {
						...expression,
						cond,
						// biome-ignore lint/suspicious/noThenProperty: AST schema field, never awaited as a thenable.
						then: thenValue,
						else: elseValue,
					};
		}
		case "switch": {
			const on = normalizeExpressionBoundaryScopes(expression.on, context);
			const cases = expression.cases.map((switchCase) => {
				const thenValue = normalizeExpressionBoundaryScopes(
					switchCase.then,
					context,
				);
				return thenValue === switchCase.then
					? switchCase
					: {
							...switchCase,
							// biome-ignore lint/suspicious/noThenProperty: AST schema field, never awaited as a thenable.
							then: thenValue,
						};
			}) as [SwitchCase, ...SwitchCase[]];
			const fallback = normalizeExpressionBoundaryScopes(
				expression.fallback,
				context,
			);
			return on === expression.on &&
				cases.every(
					(switchCase, index) => switchCase === expression.cases[index],
				) &&
				fallback === expression.fallback
				? expression
				: { ...expression, on, cases, fallback };
		}
		case "count": {
			const relation = canonicalizeRelationPath(expression.via, context);
			const where =
				expression.where === undefined
					? undefined
					: normalizeRelationEvaluationScopes(
							expression.where,
							contextAtRelationDestination(context, relation),
						);
			return relation.via === expression.via && where === expression.where
				? expression
				: { ...expression, via: relation.via, where };
		}
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`normalizeExpressionBoundaryScopes: unhandled ValueExpression kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function inspectLeafScope(
	predicate: Predicate,
	context: RelationEvaluationScopeContext,
): ScopeInspection {
	const inspection: ScopeInspection = {
		relatedScopes: new Map(),
		selfPropertyCount: 0,
		hasAnchorSensitiveBoundary: false,
	};
	inspectPredicate(predicate, inspection, false, context);
	return inspection;
}

function inspectProperty(
	property: PropertyRef,
	inspection: ScopeInspection,
	context: RelationEvaluationScopeContext,
): void {
	const via = property.via;
	if (via === undefined || via.kind === "self") {
		inspection.selfPropertyCount += 1;
		return;
	}
	inspection.relatedScopes.set(relationScopeKey(property, context), {
		via: canonicalRelationPath(property, context),
	});
}

function inspectPredicate(
	predicate: Predicate,
	inspection: ScopeInspection,
	insideBoundary: boolean,
	context: RelationEvaluationScopeContext,
): void {
	if (insideBoundary) return;
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
			inspectExpression(predicate.left, inspection, context);
			inspectExpression(predicate.right, inspection, context);
			return;
		case "in":
			inspectExpression(predicate.left, inspection, context);
			return;
		case "between":
			inspectExpression(predicate.left, inspection, context);
			if (predicate.lower !== undefined)
				inspectExpression(predicate.lower, inspection, context);
			if (predicate.upper !== undefined)
				inspectExpression(predicate.upper, inspection, context);
			return;
		case "is-null":
		case "is-blank":
			inspectExpression(predicate.left, inspection, context);
			return;
		case "match":
			inspectProperty(predicate.property, inspection, context);
			inspectExpression(predicate.value, inspection, context);
			return;
		case "multi-select-contains":
			inspectProperty(predicate.property, inspection, context);
			return;
		case "within-distance":
			inspectProperty(predicate.property, inspection, context);
			inspectExpression(predicate.center, inspection, context);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses)
				inspectPredicate(clause, inspection, false, context);
			return;
		case "not":
			inspectPredicate(predicate.clause, inspection, false, context);
			return;
		case "when-input-present":
			inspectPredicate(predicate.clause, inspection, false, context);
			return;
		case "exists":
		case "missing":
			inspection.hasAnchorSensitiveBoundary = true;
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`inspectRelationLeafScope: unhandled Predicate kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function inspectExpression(
	expression: ValueExpression,
	inspection: ScopeInspection,
	context: RelationEvaluationScopeContext,
): void {
	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "prop")
				inspectProperty(expression.term, inspection, context);
			return;
		case "today":
		case "now":
			return;
		case "date-add":
			inspectExpression(expression.date, inspection, context);
			inspectExpression(expression.quantity, inspection, context);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			inspectExpression(expression.value, inspection, context);
			return;
		case "format-date":
			inspectExpression(expression.date, inspection, context);
			return;
		case "arith":
			inspectExpression(expression.left, inspection, context);
			inspectExpression(expression.right, inspection, context);
			return;
		case "concat":
			for (const part of expression.parts)
				inspectExpression(part, inspection, context);
			return;
		case "coalesce":
			for (const value of expression.values)
				inspectExpression(value, inspection, context);
			return;
		case "if":
			inspectPredicate(expression.cond, inspection, false, context);
			inspectExpression(expression.then, inspection, context);
			inspectExpression(expression.else, inspection, context);
			return;
		case "switch":
			inspectExpression(expression.on, inspection, context);
			for (const switchCase of expression.cases)
				inspectExpression(switchCase.then, inspection, context);
			inspectExpression(expression.fallback, inspection, context);
			return;
		case "count":
			inspection.hasAnchorSensitiveBoundary = true;
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`inspectRelationLeafScope: unhandled ValueExpression kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function relationScopeKey(
	property: PropertyRef,
	context: RelationEvaluationScopeContext,
): string {
	const via = property.via;
	if (via === undefined || via.kind === "self")
		return `self:${property.caseType}`;
	const destinationCaseType = relationPropertyDestinationCaseType(
		property,
		context,
	);
	return `${property.caseType}->${destinationCaseType}:${relationPathKey(
		canonicalRelationPath(property, context),
	)}`;
}

/**
 * Resolve every optional relation qualifier the schema can infer. Qualifiers
 * are semantic row-set constraints, not cosmetic authoring hints: two walks
 * share one evaluation scope only when every hop reaches the same case type.
 * Canonicalization lets an omitted unique qualifier coalesce with its explicit
 * equivalent while preserving different intermediate ancestor types and
 * same-identifier child types as distinct scopes. The canonical path is also
 * the path placed on the generated `exists`, so an equivalent unqualified ref
 * cannot erase a type constraint contributed by its sibling.
 */
function canonicalRelationPath(
	property: PropertyRef,
	context: RelationEvaluationScopeContext,
): Exclude<RelationPath, { kind: "self" }> {
	const via = property.via;
	if (via === undefined || via.kind === "self") {
		throw new Error(
			"canonicalRelationPath: a self-scoped property has no relation path",
		);
	}
	return canonicalizeRelationPath(via, {
		...context,
		currentCaseType: property.caseType,
	}).via as Exclude<RelationPath, { kind: "self" }>;
}

export interface CanonicalRelationPath {
	readonly via: RelationPath;
	readonly destinationCaseType?: string;
}

/**
 * Materialize every type qualifier and direction the type checker can infer
 * for an explicit relation boundary. The wire must carry those constraints:
 * CCHQ's case graph can contain another case type using the same index
 * identifier, so omitting a uniquely inferred qualifier would widen the
 * authored row set. A canonical either-direction parent walk also becomes a
 * directed walk when its chosen destination exists on only one graph side.
 */
export function canonicalizeRelationPath(
	via: RelationPath,
	context: RelationEvaluationScopeContext,
): CanonicalRelationPath {
	if (via.kind === "self") {
		return { via, destinationCaseType: context.currentCaseType };
	}
	const caseTypes = context.caseTypes;
	const origin = context.currentCaseType;
	if (via.kind === "ancestor") {
		let currentCaseType = origin;
		let changed = false;
		const steps = via.via.map((step) => {
			if (step.identifier !== "parent") {
				if (step.throughCaseType !== undefined) {
					currentCaseType = step.throughCaseType;
				}
				return step;
			}
			const resolvedCaseType =
				step.throughCaseType ??
				(currentCaseType === undefined
					? undefined
					: caseTypes?.find((candidate) => candidate.name === currentCaseType)
							?.parent_type);
			if (resolvedCaseType !== undefined) currentCaseType = resolvedCaseType;
			if (
				step.throughCaseType === undefined &&
				resolvedCaseType !== undefined
			) {
				changed = true;
				return { ...step, throughCaseType: resolvedCaseType };
			}
			return step;
		}) as typeof via.via;
		return {
			via: changed ? { kind: "ancestor", via: steps } : via,
			...(currentCaseType === undefined
				? {}
				: { destinationCaseType: currentCaseType }),
		};
	}

	if (via.identifier !== "parent") {
		return {
			via,
			...(via.ofCaseType === undefined
				? {}
				: { destinationCaseType: via.ofCaseType }),
		};
	}
	const candidates = (() => {
		if (caseTypes === undefined || origin === undefined) return [];
		const children = caseTypes
			.filter((candidate) => candidate.parent_type === origin)
			.map((candidate) => candidate.name);
		if (via.kind === "subcase") return children;
		const originType = caseTypes.find((candidate) => candidate.name === origin);
		return [
			...(originType?.parent_type === undefined
				? []
				: [originType.parent_type]),
			...children,
		].filter((candidate, index, all) => all.indexOf(candidate) === index);
	})();
	const destinationCaseType =
		via.ofCaseType ?? (candidates.length === 1 ? candidates[0] : undefined);
	if (
		via.kind === "any-relation" &&
		destinationCaseType !== undefined &&
		caseTypes !== undefined &&
		origin !== undefined
	) {
		const parentCaseType = caseTypes.find(
			(candidate) => candidate.name === origin,
		)?.parent_type;
		const reachesParent = parentCaseType === destinationCaseType;
		const reachesChild = caseTypes.some(
			(candidate) =>
				candidate.name === destinationCaseType &&
				candidate.parent_type === origin,
		);

		// `any-relation(parent)` only needs the two-direction expansion when the
		// case graph genuinely leaves the direction unresolved. If the selected
		// destination is exclusively the origin's parent or exclusively one of
		// its children, materialize that proven direction. Besides producing a
		// smaller query, this preserves CSQL expressiveness: CCHQ rejects a child
		// walk nested in an ancestor arm, so emitting an impossible ancestor arm
		// would reject a valid child-only predicate. A recursive case type may be
		// both parent and child; keep `any-relation` in that case.
		if (reachesParent !== reachesChild) {
			return reachesParent
				? {
						via: {
							kind: "ancestor",
							via: [
								{
									identifier: via.identifier,
									throughCaseType: destinationCaseType,
								},
							],
						},
						destinationCaseType,
					}
				: {
						via: {
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
			via.ofCaseType === undefined && destinationCaseType !== undefined
				? { ...via, ofCaseType: destinationCaseType }
				: via,
		...(destinationCaseType === undefined ? {} : { destinationCaseType }),
	};
}

function contextAtRelationDestination(
	context: RelationEvaluationScopeContext,
	relation: CanonicalRelationPath,
): RelationEvaluationScopeContext {
	return relation.destinationCaseType === undefined
		? context
		: { ...context, currentCaseType: relation.destinationCaseType };
}

function relationPathKey(via: Exclude<RelationPath, { kind: "self" }>): string {
	switch (via.kind) {
		case "ancestor":
			return `ancestor:${via.via
				.map(
					(step) =>
						`${step.identifier}->${step.throughCaseType ?? "<unresolved>"}`,
				)
				.join("/")}`;
		case "subcase":
			return `subcase:${via.identifier}->${via.ofCaseType ?? "<unresolved>"}`;
		case "any-relation":
			return `any-relation:${via.identifier}->${via.ofCaseType ?? "<unresolved>"}`;
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`relationPathKey: unhandled relation '${String(_exhaustive)}'.`,
			);
		}
	}
}

function rebaseProperty(
	property: PropertyRef,
	scopeKey: string,
	context: RelationEvaluationScopeContext,
): PropertyRef {
	if (property.via === undefined || property.via.kind === "self")
		return property;
	if (relationScopeKey(property, context) !== scopeKey) return property;
	return {
		kind: "prop",
		caseType: relationPropertyDestinationCaseType(property, context),
		property: property.property,
	};
}

function rebasePredicate(
	predicate: Predicate,
	scopeKey: string,
	context: RelationEvaluationScopeContext,
): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				...predicate,
				left: rebaseExpression(predicate.left, scopeKey, context),
				right: rebaseExpression(predicate.right, scopeKey, context),
			};
		case "in":
			return {
				...predicate,
				left: rebaseExpression(predicate.left, scopeKey, context),
			};
		case "between":
			return {
				...predicate,
				left: rebaseExpression(predicate.left, scopeKey, context),
				...(predicate.lower === undefined
					? {}
					: { lower: rebaseExpression(predicate.lower, scopeKey, context) }),
				...(predicate.upper === undefined
					? {}
					: { upper: rebaseExpression(predicate.upper, scopeKey, context) }),
			};
		case "is-null":
		case "is-blank":
			return {
				...predicate,
				left: rebaseExpression(predicate.left, scopeKey, context),
			};
		case "match":
			return {
				...predicate,
				property: rebaseProperty(predicate.property, scopeKey, context),
				value: rebaseExpression(predicate.value, scopeKey, context),
			};
		case "multi-select-contains":
			return {
				...predicate,
				property: rebaseProperty(predicate.property, scopeKey, context),
			};
		case "within-distance":
			return {
				...predicate,
				property: rebaseProperty(predicate.property, scopeKey, context),
				center: rebaseExpression(predicate.center, scopeKey, context),
			};
		case "and":
		case "or":
			return {
				...predicate,
				clauses: predicate.clauses.map((clause) =>
					rebasePredicate(clause, scopeKey, context),
				) as [Predicate, ...Predicate[]],
			};
		case "not":
			return {
				...predicate,
				clause: rebasePredicate(predicate.clause, scopeKey, context),
			};
		case "when-input-present":
			return {
				...predicate,
				clause: rebasePredicate(predicate.clause, scopeKey, context),
			};
		case "exists":
		case "missing":
			return predicate;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`rebaseRelationLeafScope: unhandled Predicate kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

function rebaseExpression(
	expression: ValueExpression,
	scopeKey: string,
	context: RelationEvaluationScopeContext,
): ValueExpression {
	switch (expression.kind) {
		case "term":
			return expression.term.kind === "prop"
				? {
						kind: "term",
						term: rebaseProperty(expression.term, scopeKey, context),
					}
				: expression;
		case "today":
		case "now":
			return expression;
		case "date-add":
			return {
				...expression,
				date: rebaseExpression(expression.date, scopeKey, context),
				quantity: rebaseExpression(expression.quantity, scopeKey, context),
			};
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return {
				...expression,
				value: rebaseExpression(expression.value, scopeKey, context),
			};
		case "format-date":
			return {
				...expression,
				date: rebaseExpression(expression.date, scopeKey, context),
			};
		case "arith":
			return {
				...expression,
				left: rebaseExpression(expression.left, scopeKey, context),
				right: rebaseExpression(expression.right, scopeKey, context),
			};
		case "concat":
			return {
				...expression,
				parts: expression.parts.map((part) =>
					rebaseExpression(part, scopeKey, context),
				) as [ValueExpression, ValueExpression, ...ValueExpression[]],
			};
		case "coalesce":
			return {
				...expression,
				values: expression.values.map((value) =>
					rebaseExpression(value, scopeKey, context),
				) as [ValueExpression, ValueExpression, ...ValueExpression[]],
			};
		case "if":
			return {
				...expression,
				cond: rebasePredicate(expression.cond, scopeKey, context),
				// biome-ignore lint/suspicious/noThenProperty: AST schema field, never awaited as a thenable.
				then: rebaseExpression(expression.then, scopeKey, context),
				else: rebaseExpression(expression.else, scopeKey, context),
			};
		case "switch":
			return {
				...expression,
				on: rebaseExpression(expression.on, scopeKey, context),
				cases: expression.cases.map((switchCase) => ({
					...switchCase,
					// biome-ignore lint/suspicious/noThenProperty: AST schema field, never awaited as a thenable.
					then: rebaseExpression(switchCase.then, scopeKey, context),
				})) as [SwitchCase, ...SwitchCase[]],
				fallback: rebaseExpression(expression.fallback, scopeKey, context),
			};
		case "count":
			return expression;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`rebaseRelationLeafScope: unhandled ValueExpression kind '${String(_exhaustive)}'.`,
			);
		}
	}
}
