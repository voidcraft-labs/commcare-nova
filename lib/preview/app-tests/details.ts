import type { AppTestScope } from "@/lib/db/appTests";
import {
	collectLocalizedTranslationUnits,
	effectiveCaseTypes,
	orderedColumns,
} from "@/lib/domain";
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
import { projectLocalizedCaseProperties } from "../localizedCaseProperties";
import { previewMenuCaseContext } from "../menuProjection";
import { projectWorkerModule } from "../workerModule";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";
import type { AppTestState } from "./types";

/** Details addresses the selected identity, not its old Results page/filter. */
export async function appTestDetails(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestState,
) {
	const screen = state.screen;
	if (screen.kind !== "details")
		throw new AppTestActionError("Open record details first.");
	const mod = projectWorkerModule(
		context.doc,
		context.language,
		screen.moduleUuid,
	);
	if (!mod?.caseType)
		throw new AppTestActionError("This menu has no record type.");
	const selected = previewMenuCaseContext(
		context.doc,
		screen.moduleUuid,
		state.selections,
	);
	if (selected.requiredParentCase)
		throw new AppTestActionError("Select the required parent record first.");
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
	const project = appTestCellProjector(context, screen.moduleUuid, "detail");
	return {
		result,
		fields: result.kind === "row" ? project(result.row) : [],
	};
}

export function appTestCellProjector(
	context: AppTestContext,
	moduleUuid: import("@/lib/domain").Uuid,
	surface: "list" | "detail",
) {
	const mod = projectWorkerModule(context.doc, context.language, moduleUuid);
	if (!mod) throw new AppTestActionError("This menu is unavailable.");
	const columns = mod.caseListConfig
		? orderedColumns(mod.caseListConfig, surface).filter((column) =>
				surface === "list"
					? column.visibleInList !== false
					: column.visibleInDetail !== false,
			)
		: [];
	const caseTypes = effectiveCaseTypes(context.doc);
	const display: ColumnDisplayContext = {
		caseProperties: projectLocalizedCaseProperties(
			mod.caseType,
			caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [],
			new Map(
				collectLocalizedTranslationUnits(context.doc, context.language).map(
					(unit) => [unit.id, unit.effective],
				),
			),
		),
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
	return (
		row: import("../engine/caseDataBindingTypes").CaseRowWithCalculated,
	) =>
		columns.map((column) => ({
			uuid: column.uuid,
			label: caseColumnLabel(
				column,
				display.caseProperties,
				display.projectProse,
			),
			format: column.kind,
			...projectColumnDisplay(column, row, display),
		}));
}
