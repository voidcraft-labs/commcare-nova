/**
 * Normalize CCHQ's historical standard-property aliases at Nova's tool
 * boundary. Existing blueprints may still contain the old spellings for
 * compatibility, but anything newly authored through the SA or MCP tools is
 * persisted using Nova's one canonical vocabulary.
 */

import { canonicalCasePropertyName } from "@/lib/domain";
import {
	type Predicate,
	type ValueExpression,
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";

/** Return a detached predicate whose property references use Nova names. */
export function canonicalizePredicateCaseProperties(
	predicate: Predicate,
): Predicate {
	const canonical = structuredClone(predicate);
	walkTerms(canonical, (term) => {
		if (term.kind === "prop") {
			term.property = canonicalCasePropertyName(term.property);
		}
	});
	return canonical;
}

/** Return a detached expression whose property references use Nova names. */
export function canonicalizeExpressionCaseProperties(
	expression: ValueExpression,
): ValueExpression {
	const canonical = structuredClone(expression);
	walkExpressionTerms(canonical, (term) => {
		if (term.kind === "prop") {
			term.property = canonicalCasePropertyName(term.property);
		}
	});
	return canonical;
}
