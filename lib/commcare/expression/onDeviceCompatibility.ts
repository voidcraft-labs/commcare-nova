/**
 * Compatibility checks for a ValueExpression whose root is evaluated as one
 * scalar by CommCare Core's on-device XPath engine.
 *
 * Two schema-valid persisted shapes are not valid scalar device expressions:
 *
 * - `unwrap-list` is a CCHQ CSQL value function, but Core does not register an
 *   XPath function by that name. It remains valid when the CSQL emitter keeps
 *   it server-side.
 * - a property reached through `subcase` or a genuinely bidirectional
 *   `any-relation` can yield several case nodes. Core's scalar operators unpack
 *   a node-set and throw when it has more than one item. `ancestor` stays valid
 *   because one case index names at most one ancestor; the graph canonicalizer
 *   also admits a legacy `any-relation(parent)` whose chosen destination is
 *   provably parent-only. `count(via, ...)` is the explicit aggregate for every
 *   multi-valued shape.
 *
 * Predicate subtrees carried by `if.cond` and `count.where` are deliberately
 * excluded from the relation-cardinality check. The predicate emitter lowers
 * their related reads into explicit quantifiers before evaluating them. They
 * are still included in the `unwrap-list` scan because an unsupported function
 * anywhere in a device predicate would fail at runtime.
 */

import {
	type PropertyRef,
	type ValueExpression,
	walkExpressionNodes,
} from "@/lib/domain/predicate";
import {
	canonicalizeRelationPath,
	type RelationEvaluationScopeContext,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";

export type OnDeviceScalarExpressionIssue =
	| {
			readonly reason: "unwrap-list";
			readonly expression: Extract<ValueExpression, { kind: "unwrap-list" }>;
	  }
	| {
			readonly reason: "table-lookup";
			readonly expression: Extract<ValueExpression, { kind: "table-lookup" }>;
	  }
	| {
			readonly reason: "multi-valued-relation-read";
			readonly property: PropertyRef;
	  };

/** Return the first device incompatibility in a scalar expression root. */
export function findOnDeviceScalarExpressionIssue(
	expression: ValueExpression,
	context: RelationEvaluationScopeContext = {},
): OnDeviceScalarExpressionIssue | undefined {
	let tableLookup:
		| Extract<ValueExpression, { kind: "table-lookup" }>
		| undefined;
	let unwrapList: Extract<ValueExpression, { kind: "unwrap-list" }> | undefined;
	walkExpressionNodes(expression, (node) => {
		if (tableLookup === undefined && node.kind === "table-lookup") {
			tableLookup = node;
		}
		if (unwrapList === undefined && node.kind === "unwrap-list") {
			unwrapList = node;
		}
	});
	if (tableLookup !== undefined) {
		return { reason: "table-lookup", expression: tableLookup };
	}
	if (unwrapList !== undefined) {
		return { reason: "unwrap-list", expression: unwrapList };
	}

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
		case "unwrap-list":
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
			// Reported by the explicit dormant-carrier compatibility issue above.
			// Its `where` predicate is a separate lookup-row evaluation scope, not
			// a scalar case-property read at this expression root.
			return undefined;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}
