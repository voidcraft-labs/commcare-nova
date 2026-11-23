/** Project semantic findings from this saved slot, preserving its owning validation code. */
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	checkExpression,
	slotContext,
	walkExpressionNodes,
} from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "./shared";

export function calculatedColumnTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];

	const errors: ValidationError[] = [];

	for (let index = 0; index < columns.length; index++) {
		const column = columns[index];
		if (column.kind === "id-mapping" || column.kind === "image-map") {
			for (const [rowIndex, row] of column.mapping.entries()) {
				if (!row.when) continue;
				const details = {
					columnUuid: column.uuid,
					slot: `caseListConfig.columns[${index}].mapping[${rowIndex}].when`,
					registrySlot: "case_list_mapping_condition",
					rowIndex: String(rowIndex),
				};
				const location = { moduleUuid, moduleName: mod.name };
				if (
					!row.uuid ||
					(column.kind === "id-mapping" && column.behavior !== "first-match")
				) {
					errors.push(
						validationError(
							"CASE_LIST_MAPPING_CONDITION",
							"module",
							"Choose the first matching rule for this row and give it a stable identity.",
							location,
							details,
						),
					);
					continue;
				}
				const ctx = slotContext(
					doc,
					{
						entity: "module",
						uuid: moduleUuid,
						slot: "case_list_mapping_condition",
						member: { columnUuid: column.uuid, rowUuid: row.uuid },
					},
					lookupTables ?? new Map(),
				);
				if (!ctx) continue;
				for (const problem of semanticCheckErrors(
					checkExpression(row.when, ctx),
				))
					errors.push(
						validationError(
							"CASE_LIST_MAPPING_CONDITION",
							"module",
							`Rule ${rowIndex + 1} in "${column.header}" needs a condition for this case. ${problem.message}`,
							location,
							{ ...details, ...checkErrorDetails(problem) },
						),
					);
			}
		}
		if (column.kind !== "calculated") continue;
		let hiddenTextRead = false;
		if (
			column.texts?.length &&
			column.visibleInList === false &&
			!column.notOnList
		)
			walkExpressionNodes(column.expression, (node) => {
				if (node.kind === "case-text") hiddenTextRead = true;
			});
		if (
			(column.texts !== undefined && column.showAs === "formatted-text") ||
			hiddenTextRead
		)
			errors.push(
				validationError(
					"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
					"module",
					column.showAs === "formatted-text"
						? "Translated calculations display plain text. Choose Plain text to use this wording."
						: "A hidden list calculation cannot read translated wording. Show this field on the list or remove it from Results and keep it on Details.",
					{ moduleUuid, moduleName: mod.name },
					{
						columnUuid: column.uuid,
						slot: `caseListConfig.columns[${index}].texts`,
					},
				),
			);
		const ctx = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "case_list_column_expression",
				member: { columnUuid: column.uuid },
			},
			lookupTables ?? new Map(),
		);
		if (ctx === undefined) continue;
		const typeErrors = semanticCheckErrors(
			checkExpression(column.expression, ctx),
		);
		if (typeErrors.length === 0) continue;

		for (const err of typeErrors) {
			const at = formatPath(err.path);
			const suffix = at ? ` at \`${at}\`` : "";
			errors.push(
				validationError(
					"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
					"module",
					`Calculated column "${column.header}" (column #${index + 1}, uuid "${column.uuid}") on the case list of module "${mod.name}" has an expression that doesn't type-check${suffix}: ${err.message}. The expression's operand types and the operator's expected types didn't line up. Open the column's expression editor and adjust the operand at that path. Common fixes are pointing the property reference at a different case property whose \`data_type\` matches, swapping the operator for one that admits these operands, or wrapping a literal in the right shape (for example casting a text literal to a number).`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						columnUuid: column.uuid,
						slot: `caseListConfig.columns[${index}].expression`,
						registrySlot: "case_list_column_expression",
						...checkErrorDetails(err),
					},
				),
			);
		}
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
		if (!context) continue;
		for (const error of semanticCheckErrors(
			checkExpression(rule.expression, context),
		)) {
			errors.push(
				validationError(
					"CASE_LIST_CALCULATED_SORT_TYPE_ERROR",
					"module",
					`The order calculation in "${mod.name}" needs a value for each case. ${error.message}`,
					{ moduleUuid, moduleName: mod.name },
					{
						sortUuid: rule.uuid,
						index: String(index),
						slot: `caseListConfig.calculatedSorts[${index}].expression`,
						registrySlot: "case_list_sort_expression",
						...checkErrorDetails(error),
					},
				),
			);
		}
	}
	return errors;
}
