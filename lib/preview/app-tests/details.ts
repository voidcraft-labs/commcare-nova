import { workerLookupSchemas } from "@/lib/case-store/sql/compileLookup";
import type { AppTestScope } from "@/lib/db/appTests";
import {
	workerLocalizedValues,
	workerOutputOverrides,
} from "@/lib/doc/localizationWorkspace";
import {
	effectiveCaseTypes,
	moduleFormsReadSearch,
	orderedColumns,
	tileCellOnlyOnAndroid,
	type Uuid,
} from "@/lib/domain";
import { resolveCaseFormContext } from "@/lib/domain/caseFormContext";
import { availableDetailTabs } from "@/lib/domain/detailTabs";
import { slotContext } from "@/lib/domain/expression/context";
import type { CaseQueryReading } from "@/lib/domain/expression/temporalType";
import { lookupReadTypes } from "@/lib/domain/lookupRead";
import { projectProseTemplate } from "@/lib/domain/prose";
import { searchResultDetailColumns } from "@/lib/domain/searchResultDetail";
import { caseColumnLabel } from "../caseColumnLabel";
import { ordinaryCaseResultCell } from "../caseMap";
import { parentCaseConstraint } from "../caseSelectionNavigation";
import { tileResultsColumns } from "../caseTileRendering";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
	resolveCalculatedTemporalType,
} from "../columnDisplay";
import { readCaseData } from "../engine/caseDataBindingHelpers";
import { previewCaseListOrderLocale } from "../engine/caseListOrder";
import { previewSessionValues } from "../engine/identity";
import {
	previewCaseStoreBindings,
	withSearchInputExpressionValues,
} from "../engine/runtimeBindings";
import {
	searchResultDetailProjection,
	submittedSearchResultDetailAnswers,
} from "../engine/searchResultDetailProjection";
import { recordsReadSearch, searchedReading } from "../engine/serverSearchRead";
import {
	columnOutputWording,
	projectLocalizedCaseProperties,
	relatedColumnProperties,
} from "../localizedCaseProperties";
import {
	previewMenuCaseContext,
	previewSelectionsBefore,
} from "../menuProjection";
import { previewPinnedCaseTile } from "../pinnedCaseTile";
import { previewPlatformRules } from "../platform";
import {
	projectWorkerColumn,
	projectWorkerModule,
	workerDetailTabTitle,
} from "../workerModule";
import type { AppTestContext } from "./context";
import { readingSurface } from "./dataRefusal";
import { AppTestActionError } from "./errors";
import type { AppTestSessionState } from "./types";

/** Details addresses the selected identity, not its old Results page/filter. */
export async function appTestDetails(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
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
	const { caseListConfig } = mod;
	const selected = previewMenuCaseContext(
		context.doc,
		screen.moduleUuid,
		state.selections,
	);
	if (selected.requiredParentCase)
		throw new AppTestActionError("Select the required parent record first.");
	const searched = recordsReadSearch(mod, screen.source);
	const reading = searchedReading(searched);
	const storedRow = await readDisplayRow(
		context,
		scope,
		mod.uuid,
		screen.caseId,
		searched,
		screen.source.searchAnswers,
		parentCaseConstraint(context.doc, screen.moduleUuid, selected.parentCase),
	);
	// The server persisted these submitted answers with the exact page the
	// test selected from. A Search draft cannot enter a Details step.
	const columns =
		searched &&
		screen.source.searchAnswers !== undefined &&
		context.device.platform === "web-apps"
			? searchResultDetailColumns(
					context.doc,
					context.doc.modules[screen.moduleUuid],
				)
			: [];
	const calculated = searchResultDetailProjection(
		columns,
		submittedSearchResultDetailAnswers(
			columns,
			new Map(
				screen.source.searchAnswers?.map(({ name, value }) => [name, value]),
			),
			screen.source.searchEntry?.defaultSearch === true,
		),
	);
	const result =
		storedRow.kind === "row" && calculated
			? {
					...storedRow,
					row: {
						...storedRow.row,
						calculated: { ...storedRow.row.calculated, ...calculated },
					},
				}
			: storedRow;

	const project = appTestCellProjector(
		context,
		screen.moduleUuid,
		"detail",
		reading,
	);
	const fields = result.kind === "row" ? project(result.row) : [];
	const tabs =
		result.kind === "row"
			? availableDetailTabs(caseListConfig, fields, result.row.calculated)
			: undefined;
	const localized = workerLocalizedValues(context.doc, context.language);
	const active =
		tabs?.find(({ tab }) => tab.uuid === screen.tabUuid) ?? tabs?.[0];
	return {
		result,
		tabs: tabs?.map(({ tab }) => ({
			uuid: tab.uuid,
			title: workerDetailTabTitle(
				tab,
				searched && !moduleFormsReadSearch(mod),
				localized,
			),
			selected: active?.tab.uuid === tab.uuid,
		})),
		fields:
			tabs === undefined
				? fields
				: active
					? fields.slice(active.start, active.end)
					: [],
	};
}

/** The rendered layout can be supplied by another menu. The caller carries
 * the selected case and its read population separately from that layout. */
async function readDisplayRow(
	context: AppTestContext,
	scope: AppTestScope,
	moduleUuid: Uuid,
	caseId: string,
	searched: boolean,
	answers?: readonly { name: string; value: string }[],
	parentCase?: ReturnType<typeof parentCaseConstraint>,
) {
	const menu = context.doc.modules[moduleUuid];
	const config = menu?.caseListConfig;
	if (!menu?.caseType || !config)
		throw new AppTestActionError("This case layout is unavailable.");
	const caseType = menu.caseType;
	return readingSurface("list", () =>
		readCaseData(context.store, {
			appId: scope.appId,
			caseType,
			caseId,
			caseListConfig: config,
			contextModuleUuid: moduleUuid,
			reading: searchedReading(searched),
			ancestorDepth: 0,
			locale: previewCaseListOrderLocale(
				context.doc,
				caseType,
				context.language,
			),
			caseTypeSchemas: context.caseTypeSchemas,
			parentCase,
			bindings: previewCaseStoreBindings(
				previewSessionValues(context.identity, context.device),
				context.rules,
				config.searchInputs,
				withSearchInputExpressionValues(
					config.searchInputs,
					new Map(answers?.map((row) => [row.name, row.value])),
				),
				context.clock.timeZone,
			),
			lookupTableSchemas: workerLookupSchemas(scope.projectId, context.lookup),
			// A record chosen from a search's Results reads as the search found it.
			...(searched
				? { searchPopulation: { heldBy: context.restoreScope } }
				: { restoreScope: context.restoreScope }),
		}),
	);
}

export async function appTestFormCaseContext(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
) {
	const screen = state.screen;
	if (screen.kind !== "form") return;
	const menuContext = previewMenuCaseContext(
		context.doc,
		screen.moduleUuid,
		state.selections,
	);
	const ownMenu = menuContext.selectedByModuleUuid ?? screen.moduleUuid;
	const before = previewSelectionsBefore(
		context.doc,
		screen.moduleUuid,
		state.selections,
	).filter((choice) => choice.moduleUuid !== ownMenu);
	const choices = [
		...before,
		...(screen.caseIds.length === 1
			? [{ moduleUuid: ownMenu, cases: [{ caseId: screen.caseIds[0] }] }]
			: []),
	];
	const chosen = previewPinnedCaseTile(
		context.doc.modules,
		choices,
		"form",
		context.rules,
	);
	if (!chosen) return;
	const source = resolveCaseFormContext(context.doc.modules, chosen.moduleUuid);
	if (!source) return;
	const { sourceModuleUuid: owner, inlineModuleUuid: inline, kind } = source;
	const selecting = context.doc.modules[chosen.moduleUuid];
	const history = state.history.findLast(
		(frame) =>
			frame.kind === "records" && frame.moduleUuid === chosen.moduleUuid,
	);
	const answers =
		chosen.moduleUuid === screen.moduleUuid
			? (screen.searchAnswers ??
				(history?.kind === "records" ? history.searchAnswers : undefined))
			: history?.kind === "records"
				? history.searchAnswers
				: undefined;
	const searched = moduleFormsReadSearch(selecting) && answers !== undefined;
	const row = await readDisplayRow(
		context,
		scope,
		owner,
		chosen.caseId,
		searched,
		answers,
	);
	const expanded = !!inline && screen.contextExpanded === true;
	const base = {
		kind,
		caseId: chosen.caseId,
		sourceModuleUuid: owner,
		selectionModuleUuid: chosen.moduleUuid,
		expandable: !!inline,
		expanded,
	};
	if (row.kind !== "row") return { ...base, unavailable: true };
	if (kind === "line")
		return { ...base, value: row.row.calculated[owner] ?? "" };
	const reading = searchedReading(searched);
	const list = appTestCellProjector(context, owner, "list", reading)(row.row);
	const config = context.doc.modules[owner]?.caseListConfig;
	const slots = config
		? tileResultsColumns(orderedColumns(config, "list"), config.tile)
		: [];
	const cells = slots.flatMap(({ column }) => {
		const value = list.find((field) => field.uuid === column.uuid);
		if (
			!value ||
			!column.tile ||
			(tileCellOnlyOnAndroid(column, column.tile) &&
				previewPlatformRules(state.platform).searchOnlyTileCell === "hidden")
		)
			return [];
		return [{ ...value, placement: column.tile }];
	});
	if (!inline || !expanded) return { ...base, cells };
	const detail =
		inline === owner
			? row
			: await readDisplayRow(
					context,
					scope,
					inline,
					chosen.caseId,
					searched,
					answers,
				);
	const fields =
		detail.kind === "row"
			? appTestCellProjector(context, inline, "detail", reading)(detail.row)
			: [];
	const projected = projectWorkerModule(context.doc, context.language, inline);
	const tabs =
		detail.kind === "row"
			? availableDetailTabs(
					projected?.caseListConfig,
					fields,
					detail.row.calculated,
				)
			: undefined;
	const localized = workerLocalizedValues(context.doc, context.language);
	const active =
		tabs?.find((span) => span.tab.uuid === screen.contextTabUuid) ?? tabs?.[0];
	return {
		...base,
		cells,
		details: {
			moduleUuid: inline,
			unavailable: detail.kind !== "row",
			tabs: tabs?.map(({ tab }) => ({
				uuid: tab.uuid,
				title: workerDetailTabTitle(tab, false, localized),
				selected: tab.uuid === active?.tab.uuid,
			})),
			fields:
				tabs === undefined
					? fields
					: active
						? fields.slice(active.start, active.end)
						: [],
		},
	};
}

export function appTestCellProjector(
	context: AppTestContext,
	moduleUuid: import("@/lib/domain").Uuid,
	surface: "list" | "detail",
	/** What the read the cells come from stands for (`searchedReading`). */
	reading: CaseQueryReading,
) {
	const mod = projectWorkerModule(context.doc, context.language, moduleUuid);
	if (!mod) throw new AppTestActionError("This menu is unavailable.");
	const columns = mod.caseListConfig
		? orderedColumns(mod.caseListConfig, surface).filter((column) =>
				surface === "list"
					? column.visibleInList !== false &&
						(mod.caseListConfig?.tile !== undefined ||
							ordinaryCaseResultCell(column))
					: column.visibleInDetail !== false,
			)
		: [];
	const caseTypes = effectiveCaseTypes(context.doc);
	// A Search's Results and its Details read results rows; a browse list
	// and its Details read casedb rows.
	const columnsReading = reading.columns;
	const localizedValues = workerLocalizedValues(context.doc, context.language);
	const properties = projectLocalizedCaseProperties(
		mod.caseType,
		caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [],
		localizedValues,
	);
	const related = relatedColumnProperties(
		mod.caseListConfig,
		mod.caseType,
		caseTypes,
		localizedValues,
	);
	const searchOutput =
		reading.columns === "results" && !moduleFormsReadSearch(mod);
	const detail = surface === "detail";
	const display: ColumnDisplayContext = {
		readsCaseImageDescriptions: context.rules.readsCaseImageDescriptions,
		caseProperties: properties,
		relatedProperties: related,
		...columnOutputWording(
			mod.caseListConfig,
			mod.caseType,
			caseTypes,
			properties,
			related,
			workerOutputOverrides(context.doc, context.language),
			searchOutput,
			detail,
		),
		calculatedTemporalTypes: new Map(
			columns.flatMap((column) => {
				if (column.kind !== "calculated") return [];
				const types = slotContext(
					context.doc,
					{
						entity: "module",
						uuid: moduleUuid,
						slot: "case_list_column_expression",
						member: { columnUuid: column.uuid },
					},
					new Map(
						context.lookup.definitions.map((table) => [
							table.id,
							lookupReadTypes(table),
						]),
					),
				);
				if (types === undefined)
					throw new AppTestActionError(
						"This calculated column is unavailable.",
					);
				const type = resolveCalculatedTemporalType(
					column,
					types,
					columnsReading,
				);
				return type ? [[column.uuid, type] as const] : [];
			}),
		),
		today: new Date(),
		reading: columnsReading,
		projectProse: (template) =>
			projectProseTemplate(template, context.doc).text,
	};
	return (
		row: import("../engine/caseDataBindingTypes").CaseRowWithCalculated,
	) =>
		columns.map((col) => {
			const column = projectWorkerColumn(
				col,
				searchOutput,
				detail,
				localizedValues,
			);
			return {
				uuid: column.uuid,
				label: caseColumnLabel(
					column,
					display.caseProperties,
					display.projectProse,
					surface,
				),
				format:
					column.kind === "calculated" && column.showAs
						? column.showAs
						: column.kind,
				...projectColumnDisplay(column, row, display),
			};
		});
}
