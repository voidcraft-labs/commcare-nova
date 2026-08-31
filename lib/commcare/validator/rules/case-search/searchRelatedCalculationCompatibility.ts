/**
 * Search Results and Details share one authored calculated-column expression
 * with the ordinary case list, but supporting related cases live in Search's
 * result set. Nova can keep the two paths aligned only when the complete
 * expression is one ancestor property read. The shared projection classifier
 * owns that exact boundary; this rule turns its unsupported arm into an
 * author-facing repair before any app can save or publish with divergent
 * behavior.
 *
 * Search can be effective through an explicit zero-input configuration or
 * through markerless Search inputs, so activation follows
 * `effectiveCaseSearchConfig`. Every saved calculated definition is checked,
 * including one hidden from both screens and absent from Default order. Hiding
 * is reversible presentation state, never a way to defer an invalid formula;
 * only support-row derivation and emission consult `caseListColumnIsEmitted`.
 */

import { classifyRelatedCaseSearchExpression } from "@/lib/commcare/suite/case-search/relatedCaseProjection";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function searchRelatedCalculationCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (effectiveCaseSearchConfig(mod) === undefined) return [];

	const columns = mod.caseListConfig?.columns ?? [];
	const context = {
		caseTypes: effectiveCaseTypes(doc),
		...(mod.caseType === undefined ? {} : { currentCaseType: mod.caseType }),
	};
	const errors: ValidationError[] = [];

	for (let index = 0; index < columns.length; index++) {
		const column = columns[index];
		if (column.kind !== "calculated") continue;
		if (
			classifyRelatedCaseSearchExpression(column.expression, context).kind !==
			"unsupported"
		) {
			continue;
		}

		errors.push(
			validationError(
				"CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE",
				"module",
				`In "${mod.name}", "${column.header}" uses related-case information that Search can't show consistently. Show one parent property by itself, build the calculation from the current case, or delete this calculated item.`,
				{ moduleUuid, moduleName: mod.name },
				{
					columnUuid: column.uuid,
					columnHeader: column.header,
					index: String(index),
					slot: `caseListConfig.columns[${index}].expression`,
					registrySlot: "case_list_column_expression",
				},
			),
		);
	}

	return errors;
}
