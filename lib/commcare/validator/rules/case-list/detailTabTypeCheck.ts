import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { detailTabSearchChildType } from "@/lib/domain/detailTabs";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";

export function detailTabTypeCheck(
	mod: Module,
	uuid: Uuid,
	doc: BlueprintDoc,
	tables?: LookupTypeIndex,
): ValidationError[] {
	const findings: ValidationError[] = [];
	for (const [i, tab] of (mod.caseListConfig?.detailTabs ?? []).entries()) {
		const source = tab.rowSource;
		const at = { moduleUuid: uuid, moduleName: mod.name };
		const childType = detailTabSearchChildType(tab);
		if (childType && !doc.caseTypes?.some((type) => type.name === childType)) {
			findings.push(
				validationError(
					"CASE_DETAIL_TAB_ROWS_INVALID",
					"module",
					`Choose an existing child case type for tab "${tab.title}".`,
					at,
					{ tabUuid: tab.uuid, tabTitle: tab.title, caseType: childType },
				),
			);
		}
		for (const [slot, expr, path] of [
			["case_detail_tab_condition", tab.displayCondition, "displayCondition"],
			[
				"case_detail_tab_filter",
				source?.kind === "children" ? source.condition : undefined,
				"rowSource.condition",
			],
			[
				"case_detail_tab_rows",
				source?.kind === "records" ? source.rows : undefined,
				"rowSource.rows",
			],
		] as const) {
			if (!expr) continue;
			const ref = {
				entity: "module",
				uuid,
				slot,
				member: { tabUuid: tab.uuid },
			} as const;
			const context = slotContext(doc, ref, tables ?? new Map());
			const errors = context
				? semanticCheckErrors(checkExpression(expr, context))
				: ([
						{
							code: "unknown-case-type",
							message: "Choose a case type for this tab.",
							path: [],
						},
					] as const);
			for (const err of errors)
				findings.push(
					validationError(
						slot === "case_detail_tab_condition"
							? "CASE_DETAIL_TAB_CONDITION_INVALID"
							: "CASE_DETAIL_TAB_ROWS_INVALID",
						"module",
						`Tab "${tab.title}" in menu "${mod.name}": ${err.message}`,
						at,
						{
							...checkErrorDetails(err),
							tabUuid: tab.uuid,
							tabTitle: tab.title,
							slot: `caseListConfig.detailTabs[${i}].${path}`,
							registrySlot: slot,
						},
					),
				);
		}
	}
	return findings;
}
