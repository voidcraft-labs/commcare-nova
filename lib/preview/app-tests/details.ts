import type { AppTestScope } from "@/lib/db/appTests";
import { effectiveCaseTypes, orderedColumns } from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { caseColumnLabel } from "../caseColumnLabel";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
	resolveCalculatedTemporalType,
} from "../columnDisplay";
import { readCaseData } from "../engine/caseDataBindingHelpers";
import { previewSessionValues } from "../engine/identity";
import { previewCaseStoreBindings } from "../engine/runtimeBindings";
import { previewMenuCaseContext } from "../menuProjection";
import type { AppTestContext } from "./context";
import type { AppTestState } from "./types";

/** Details addresses the selected identity, not its old Results page/filter. */
export async function appTestDetails(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestState,
) {
	const screen = state.screen;
	if (screen.kind !== "details") throw new Error("Open record details first.");
	const mod = context.doc.modules[screen.moduleUuid];
	if (!mod.caseType) throw new Error("This menu has no record type.");
	const selected = previewMenuCaseContext(
		context.doc,
		screen.moduleUuid,
		state.selections,
	);
	if (selected.requiredParentCase)
		throw new Error("Select the required parent record first.");
	const result = await readCaseData(context.store, {
		appId: scope.appId,
		caseType: mod.caseType,
		caseId: screen.caseId,
		ancestorDepth: 0,
		caseListConfig: mod.caseListConfig,
		caseTypeSchemas: context.caseTypeSchemas,
		bindings: previewCaseStoreBindings(
			previewSessionValues(context.identity),
			undefined,
			undefined,
			context.clock.timeZone,
		),
		lookupTableSchemas: new Map(
			context.lookup.definitions.map((table) => [
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			]),
		),
		restoreScope: context.restoreScope,
		parentCase: selected.parentCase
			? {
					caseType: selected.parentCase.caseType,
					caseIds: selected.parentCase.cases.map((row) => row.caseId),
				}
			: undefined,
	});
	const columns = mod.caseListConfig
		? orderedColumns(mod.caseListConfig, "detail").filter(
				(column) => column.visibleInDetail !== false,
			)
		: [];
	const caseTypes = effectiveCaseTypes(context.doc);
	const display: ColumnDisplayContext = {
		caseProperties:
			caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [],
		calculatedTemporalTypes: new Map(
			columns.flatMap((column) => {
				const type = resolveCalculatedTemporalType(column, {
					caseTypes: [...caseTypes],
					currentCaseType: mod.caseType,
					knownInputs: [],
				});
				return type ? [[column.uuid, type] as const] : [];
			}),
		),
		today: new Date(),
		projectProse: (template) =>
			projectProseTemplate(template, context.doc).text,
	};
	return {
		result,
		fields:
			result.kind === "row"
				? columns.map((column) => ({
						uuid: column.uuid,
						label: caseColumnLabel(
							column,
							display.caseProperties,
							display.projectProse,
						),
						...projectColumnDisplay(column, result.row, display),
					}))
				: [],
	};
}
