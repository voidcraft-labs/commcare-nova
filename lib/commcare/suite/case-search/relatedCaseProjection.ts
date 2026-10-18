/**
 * Private projection from a calculated case-list expression to the related
 * case shape CommCare Search can preserve across both Nova's direct suite and
 * an HQ-regenerated suite.
 *
 * Nova stores one typed `Expression`; it never stores CommCare's detail
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

import { type CaseListConfig, caseListColumnRuns } from "@/lib/domain";
import {
	activeRowScope,
	type ExpressionContext,
} from "@/lib/domain/expression/context";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import type { Expression } from "@/lib/domain/expression/types";
import { expressionReadsRelatedCaseData } from "@/lib/domain/expression/walk";
import type { ModuleExpressionContexts } from "../../expressionContext";
import { w } from "../../xpath/wire/builders";
import type { WireExpr, WirePath } from "../../xpath/wire/tree";
import { casePropertyPath } from "../wire";

export type RelatedCaseSearchProjection =
	| { readonly kind: "none" }
	| { readonly kind: "ancestor-property"; readonly hqExpression: WireExpr }
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
 * `evalRaw` contextualizes it against the original row. The native
 * `SearchRuntimeTest` evaluates actual local and HQ-regenerated detail templates
 * against supporting rows, including a same-id row of the wrong case type.
 */
function emitHqContextRelativeAncestorProperty(
	via: Extract<
		ReturnType<typeof canonicalizeRelationPath>["via"],
		{ kind: "ancestor" }
	>["via"],
	property: string,
): WireExpr {
	let relatedCase: WirePath = w.current();
	for (const step of via) {
		const caseId = w.append(relatedCase, [
			w.step("index"),
			w.step(step.identifier),
		]);
		const filters = [w.eq(w.context([w.attr("case_id")]), caseId)];
		if (step.throughCaseType !== undefined) {
			filters.push(
				w.eq(w.context([w.attr("case_type")]), w.str(step.throughCaseType)),
			);
		}
		relatedCase = w.current([w.parent(), w.step("case", [w.and(...filters)])]);
	}
	return w.append(relatedCase, casePropertyPath(property).steps);
}

/**
 * Classify one expression without simplifying it. Only a whole-expression
 * ancestor property read has one context-relative CCHQ calculation.
 * Wrapping that read in arithmetic, formatting, a conditional, or any other
 * calculation is intentionally unsupported even when an algebraic reducer
 * could make a particular authored value smaller.
 */
export function classifyRelatedCaseSearchExpression(
	expression: Expression,
	context: ExpressionContext,
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
		caseTypes: context.facts.caseTypes,
		currentCaseType: property.caseType ?? activeCaseType(context),
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
 * Results, Details, or Default-order calculations: every calculated column a
 * runtime evaluates (`caseListColumnRuns`), which in a list with no tile
 * layout is every one, a column hidden from both screens included, since it
 * is a field of the short detail.
 */
export function searchNeedsSupportingCases(
	config: Pick<CaseListConfig, "columns" | "tile">,
	expressions: ModuleExpressionContexts,
): boolean {
	return config.columns.some(
		(column) =>
			column.kind === "calculated" &&
			caseListColumnRuns(column, config) &&
			classifyRelatedCaseSearchExpression(
				column.expression,
				expressions({
					slot: "case_list_column_expression",
					member: { columnUuid: column.uuid },
				}),
			).kind !== "none",
	);
}

function activeCaseType(context: ExpressionContext): string | undefined {
	const row = activeRowScope(context);
	return row?.kind === "case"
		? row.caseType
		: row?.kind === "table"
			? row.capturedCase?.caseType
			: undefined;
}
