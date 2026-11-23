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
 * only support-row derivation and emission consult `caseListColumnRuns`.
 */

import { classifyRelatedCaseSearchExpression } from "@/lib/commcare/suite/case-search/relatedCaseProjection";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import type { LookupTypeIndex } from "../../lookupTypeContext";

export function searchRelatedCalculationCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	if (effectiveCaseSearchConfig(mod) === undefined) return [];

	const columns = mod.caseListConfig?.columns ?? [];
	const errors: ValidationError[] = [];

	for (let index = 0; index < columns.length; index++) {
		const column = columns[index];
		if (column.kind === "id-mapping" || column.kind === "image-map") {
			for (const [rowIndex, row] of column.mapping.entries()) {
				if (!row.when || !row.uuid) continue;
				const context = slotContext(
					doc,
					{
						entity: "module",
						uuid: moduleUuid,
						slot: "case_list_mapping_condition",
						member: { columnUuid: column.uuid, rowUuid: row.uuid },
					},
					lookupTables ?? new Map(),
				);
				if (
					context &&
					classifyRelatedCaseSearchExpression(row.when, context).kind ===
						"unsupported"
				)
					errors.push(
						validationError(
							"CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE",
							"module",
							`Search cannot supply the related information in rule ${rowIndex + 1} of "${column.header}". Choose information held on this case.`,
							{ moduleUuid, moduleName: mod.name },
							{
								columnUuid: column.uuid,
								rowUuid: row.uuid,
								slot: `caseListConfig.columns[${index}].mapping[${rowIndex}].when`,
								registrySlot: "case_list_mapping_condition",
							},
						),
					);
			}
		}
		if (column.kind !== "calculated") continue;
		const context = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "case_list_column_expression",
				member: { columnUuid: column.uuid },
			},
			lookupTables ?? new Map(),
		);
		if (context === undefined) continue;
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

	for (const [index, rule] of (
		mod.caseListConfig?.calculatedSorts ?? []
	).entries()) {
		const context = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "case_list_sort_expression",
				member: { sortUuid: rule.uuid },
			},
			lookupTables ?? new Map(),
		);
		if (
			!context ||
			classifyRelatedCaseSearchExpression(rule.expression, context).kind !==
				"unsupported"
		)
			continue;
		errors.push(
			validationError(
				"CASE_SEARCH_RELATED_CALCULATION_UNREPRESENTABLE",
				"module",
				`The order calculation in "${mod.name}" uses related information that Search cannot supply. Choose one parent property or use this case's information.`,
				{ moduleUuid, moduleName: mod.name },
				{
					sortUuid: rule.uuid,
					index: String(index),
					slot: `caseListConfig.calculatedSorts[${index}].expression`,
					registrySlot: "case_list_sort_expression",
				},
			),
		);
	}
	return errors;
}
