/**
 * Private projection from a calculated case-list expression to the related
 * case shape CommCare Search can preserve across both Nova's direct suite and
 * an HQ-regenerated suite.
 *
 * Nova stores one typed `ValueExpression`; it never stores CommCare's detail
 * field path or related-case query keys. CCHQ can discover a supporting-case
 * relationship from an HQ `DetailColumn` when the column is a native ancestor
 * path, but that path drops every relation case-type qualifier. Nova instead
 * emits the one admitted parent read as a context-relative calculated XPath.
 * CCHQ copies it verbatim into the Search detail, where `current()/../case`
 * resolves against the Search roster just as it resolves against casedb in the
 * ordinary detail, while preserving every `@case_type` constraint.
 *
 * Keep this classifier at the wire boundary. Domain owns the semantic answer
 * to “does this expression read a related case?”; this module adds only the
 * narrower CCHQ representation decision.
 */

import { type CaseListConfig, caseListColumnIsEmitted } from "@/lib/domain";
import {
	canonicalizeRelationPath,
	expressionReadsRelatedCaseData,
	type RelationEvaluationScopeContext,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { emitCasePropertyWirePath } from "../../casePropertyWire";
import { quoteLiteral } from "../../predicate/stringQuoting";

export type RelatedCaseSearchProjection =
	| { readonly kind: "none" }
	| { readonly kind: "ancestor-property"; readonly hqExpression: string }
	| { readonly kind: "unsupported" };

/**
 * Build one XPath that is independent of the containing case-fixture name.
 *
 * A detail expression evaluates with `current()` on the rendered case. Its
 * parent is the fixture root, so `current()/../case` selects the sibling case
 * rows whether CCHQ is rendering the ordinary casedb detail or its copied
 * Search detail. Each nested lookup retains the canonical relation's case-type
 * filter. CommCare Core's `XPathPathExpr.getReference` admits `current()` as
 * the expression root followed by parent, child, and predicate steps, then
 * `evalRaw` contextualizes it against the original row. Runtime coverage lives
 * in `FormDefTest.testNestedRepeatActions` (`current()/../@id`) and
 * `XPathPathExprTest.testNestedPreds` (sibling `../team[...]` selection).
 */
function emitHqContextRelativeAncestorProperty(
	via: Extract<
		ReturnType<typeof canonicalizeRelationPath>["via"],
		{ kind: "ancestor" }
	>["via"],
	property: string,
): string {
	let relatedCase = "current()";
	for (const step of via) {
		const caseId = `${relatedCase}/index/${step.identifier}`;
		const typeFilter =
			step.throughCaseType === undefined
				? ""
				: ` and @case_type=${quoteLiteral(step.throughCaseType, "case-list-filter")}`;
		relatedCase = `current()/../case[@case_id=${caseId}${typeFilter}]`;
	}
	return `${relatedCase}/${emitCasePropertyWirePath(property)}`;
}

/**
 * Classify one expression without simplifying it. Only a whole-expression
 * ancestor property read has one context-relative CCHQ calculation.
 * Wrapping that read in arithmetic, formatting, a conditional, or any other
 * calculation is intentionally unsupported even when an algebraic reducer
 * could make a particular authored value smaller.
 */
export function classifyRelatedCaseSearchExpression(
	expression: ValueExpression,
	context: RelationEvaluationScopeContext = {},
): RelatedCaseSearchProjection {
	if (!expressionReadsRelatedCaseData(expression)) return { kind: "none" };

	if (expression.kind !== "term" || expression.term.kind !== "prop") {
		return { kind: "unsupported" };
	}

	const property = expression.term;
	const via = property.via;
	if (via === undefined || via.kind === "self") {
		// The semantic read guard above makes this unreachable for a lone
		// property term. Keep the classifier total if either AST walk changes.
		return { kind: "unsupported" };
	}

	const canonical = canonicalizeRelationPath(via, {
		...context,
		currentCaseType: property.caseType,
	}).via;
	if (canonical.kind !== "ancestor") return { kind: "unsupported" };

	return {
		kind: "ancestor-property",
		hqExpression: emitHqContextRelativeAncestorProperty(
			canonical.via,
			property.property,
		),
	};
}

/**
 * Whether an effective Search must carry supporting cases for its emitted
 * Results, Details, or Default-order calculations. A fully hidden, unsorted
 * definition remains valid authoring state but has no runtime effect.
 */
export function searchNeedsSupportingCases(
	config: Pick<CaseListConfig, "columns">,
	context: RelationEvaluationScopeContext = {},
): boolean {
	return config.columns.some(
		(column) =>
			column.kind === "calculated" &&
			caseListColumnIsEmitted(column) &&
			classifyRelatedCaseSearchExpression(column.expression, context).kind !==
				"none",
	);
}
