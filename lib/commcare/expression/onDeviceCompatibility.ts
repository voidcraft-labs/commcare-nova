/**
 * Compatibility checks for a ValueExpression whose root is evaluated as one
 * scalar by CommCare Core's on-device XPath engine.
 *
 * A property reached through `subcase` or a genuinely bidirectional
 *   `any-relation` can yield several case nodes. Core's scalar operators unpack
 *   a node-set and throw when it has more than one item. `ancestor` stays valid
 *   because one case index names at most one ancestor; the graph canonicalizer
 *   also admits an `any-relation(parent)` whose chosen destination proves that
 *   only the parent direction is reachable. `count(via, ...)` is the explicit
 *   aggregate for every multi-valued shape.
 *
 * Predicate subtrees carried by `if.cond` and `count.where` are deliberately
 * excluded from the relation-cardinality check. The predicate emitter lowers
 * their related reads into explicit quantifiers before evaluating them.
 */

import type { PropertyRef, ValueExpression } from "@/lib/domain/predicate";
import {
	canonicalizeRelationPath,
	type RelationEvaluationScopeContext,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";

export type OnDeviceScalarExpressionIssue = {
	readonly reason: "multi-valued-relation-read";
	readonly property: PropertyRef;
};

/** Return the first device incompatibility in a scalar expression root. */
export function findOnDeviceScalarExpressionIssue(
	expression: ValueExpression,
	context: RelationEvaluationScopeContext = {},
): OnDeviceScalarExpressionIssue | undefined {
	const property = findMultiValuedScalarPropertyRead(expression, context);
	return property === undefined
		? undefined
		: { reason: "multi-valued-relation-read", property };
}

/**
 * Walk only scalar value operands. Predicate carriers are separate evaluation
 * scopes and are normalized by the predicate emitter, so their property terms
 * must not be mistaken for a raw scalar read at this expression root.
 */
function findMultiValuedScalarPropertyRead(
	expression: ValueExpression,
	context: RelationEvaluationScopeContext,
): PropertyRef | undefined {
	switch (expression.kind) {
		case "term": {
			const term = expression.term;
			if (term.kind !== "prop" || term.via === undefined) return undefined;
			const relation = canonicalizeRelationPath(term.via, {
				...context,
				currentCaseType: context.currentCaseType ?? term.caseType,
			});
			if (
				relation.via.kind === "subcase" ||
				relation.via.kind === "any-relation"
			)
				return term;
			return undefined;
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return undefined;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			return findMultiValuedScalarPropertyRead(expression.value, context);
		case "format-date":
			return findMultiValuedScalarPropertyRead(expression.date, context);
		case "date-add":
			return (
				findMultiValuedScalarPropertyRead(expression.date, context) ??
				findMultiValuedScalarPropertyRead(expression.quantity, context)
			);
		case "arith":
			return (
				findMultiValuedScalarPropertyRead(expression.left, context) ??
				findMultiValuedScalarPropertyRead(expression.right, context)
			);
		case "concat":
			for (const part of expression.parts) {
				const property = findMultiValuedScalarPropertyRead(part, context);
				if (property !== undefined) return property;
			}
			return undefined;
		case "coalesce":
			for (const value of expression.values) {
				const property = findMultiValuedScalarPropertyRead(value, context);
				if (property !== undefined) return property;
			}
			return undefined;
		case "if":
			return (
				findMultiValuedScalarPropertyRead(expression.then, context) ??
				findMultiValuedScalarPropertyRead(expression.else, context)
			);
		case "switch": {
			const on = findMultiValuedScalarPropertyRead(expression.on, context);
			if (on !== undefined) return on;
			for (const branch of expression.cases) {
				const property = findMultiValuedScalarPropertyRead(
					branch.then,
					context,
				);
				if (property !== undefined) return property;
			}
			return findMultiValuedScalarPropertyRead(expression.fallback, context);
		}
		case "count":
			// `via` is aggregated explicitly; `where` is a normalized Predicate.
			return undefined;
		case "table-lookup":
			// Scalar-safe: the lowering selects at most one row via the explicit
			// first-match positional predicate. Its `where` is a separate
			// lookup-row evaluation scope whose related reads the predicate
			// emitter normalizes, not a raw scalar read at this expression root.
			return undefined;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}
