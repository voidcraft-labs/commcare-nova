import { entryPointRequirements } from "@/lib/doc/entryPointProjection";
import {
	type BlueprintDoc,
	conditionModulesOf,
	moduleFormsReadSearch,
	moduleHasOwnScreen,
	type Uuid,
} from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { caseRowToFormPreload } from "./engine/caseDataBindingClient";
import {
	formDisplayVisibility,
	moduleDisplayVisibility,
	type NavigationDeviceCases,
	navigationSelectedCase,
} from "./engine/displayConditionEvaluation";
import { caseListStepSession } from "./engine/entrySessionData";
import type { PreviewSearchSessionValues } from "./engine/identity";
import type { PreviewLookupStatus } from "./engine/useLookupPreviewData";
import type { CaseDatabaseSnapshot } from "./engine/xpathInstances";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
} from "./entryPointLaunchTypes";
import {
	previewContributorGatingModules,
	previewMenuCaseContext,
	previewScreenPath,
} from "./menuProjection";
import type { PreviewPlatformRules } from "./platform";

/** What Preview says when a form off the menu is launched from an entry point
 * that does not ignore display conditions. Only Web Apps reaches it: Android
 * ignores display conditions on an entry point. */
export const FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL =
	"This form is off the menu, and in Web Apps an entry point opens it only when the entry point ignores display conditions. You can set it to ignore them.";

/** Whether a module's form and case list entries are off the menu: a module
 * whose condition they carry (`menuScreens.ts::conditionModulesOf`, the module
 * and, where it shows its forms above, its parent) is off the menu, or the
 * module keeps its screen under a parent that keeps its screen and is off the
 * menu, so no menu reaches the module's own screen. */
export function moduleEntriesOffTheMenu(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	if (
		conditionModulesOf(doc, moduleUuid).some(
			(uuid) => doc.modules[uuid]?.hiddenFromMenu === true,
		)
	)
		return true;
	const parentUuid = moduleParent(doc, moduleUuid);
	return (
		moduleHasOwnScreen(doc, moduleUuid) &&
		parentUuid !== undefined &&
		parentUuid !== null &&
		moduleHasOwnScreen(doc, parentUuid) &&
		doc.modules[parentUuid]?.hiddenFromMenu === true
	);
}

/** Pure admission over one authorized device snapshot. No selection can fall
 * through to ordinary Preview's first-case convenience behavior. */
export function prepareEntryPointLaunch(args: {
	readonly doc: BlueprintDoc;
	readonly entryPointUuid: Uuid;
	readonly expectedSeq: number;
	readonly personaUuid?: string;
	readonly selections: readonly EntryPointSelection[];
	readonly database: CaseDatabaseSnapshot;
	/** The chosen cases this worker's device does not hold, read from the
	 *  Project past the worker's restore (`onlyOutsideRestore`). */
	readonly notHeld: CaseDatabaseSnapshot;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
	/** The platform Preview plays: whether display conditions hold, whether
	 *  the launch claims its cases, and what a case the phone lacks does. */
	readonly rules: Pick<
		PreviewPlatformRules,
		"entryPointDisplayConditions" | "entryPointClaims" | "entryPointCaseNotHeld"
	>;
}): EntryPointLaunchResult {
	const refuse = (message: string): EntryPointLaunchResult => ({
		kind: "refused",
		message,
	});
	const item = entryPointInventory(args.doc).find(
		(item) => item.entryPoint.uuid === args.entryPointUuid,
	);
	if (!item)
		return refuse("This entry point changed. Reload the app and try again.");
	const projection = entryPointRequirements(args.doc, item.target);
	if (!projection.available) return refuse(projection.message);
	const required = projection.requiredSelections;
	if (
		args.selections.length !== required.length ||
		new Set(args.selections.map((x) => x.moduleUuid)).size !==
			args.selections.length
	)
		return refuse("Choose cases for each required selection and try again.");
	const rows = new Map(args.database.rows.map((row) => [row.case_id, row]));
	const outsideRows = new Map(
		args.notHeld.rows
			.filter((row) => !rows.has(row.case_id))
			.map((row) => [row.case_id, row]),
	);
	/* A case the worker's device lacks: Web Apps claims it, so the form reads
	 * it with its saved values; Android opens the form with blank preloads,
	 * as Core checks only the datum's key. */
	const blankCaseIds: string[] = [];
	// This plan crosses a Server Action boundary; React requires plain objects.
	const menuSelections: Record<string, PreviewMenuCaseSelection> = {};
	for (const requirement of required) {
		const selection = args.selections.find(
			(x) => x.moduleUuid === requirement.moduleUuid,
		);
		if (
			!selection ||
			selection.caseIds.length === 0 ||
			selection.caseIds.length > requirement.maximum ||
			(requirement.cardinality === "one" && selection.caseIds.length !== 1) ||
			new Set(selection.caseIds).size !== selection.caseIds.length ||
			selection.caseIds.some((id) => !id)
		)
			return refuse(
				"Choose the required number of distinct cases and try again.",
			);
		const selectedRows = selection.caseIds.map(
			(id) => rows.get(id) ?? outsideRows.get(id),
		);
		if (
			selectedRows.some((row) => !row || row.case_type !== requirement.caseType)
		)
			return refuse(
				"One or more cases are unavailable to this Preview worker. Choose cases this worker has. Preview uses this worker’s cases, including ones they chose from a search.",
			);
		menuSelections[requirement.moduleUuid] = {
			caseType: requirement.caseType,
			cases: selectedRows.map((row) => {
				if (!row)
					throw new Error("Selected case disappeared from immutable snapshot.");
				const blank =
					!rows.has(row.case_id) &&
					args.rules.entryPointCaseNotHeld === "opens-blank";
				if (blank) blankCaseIds.push(row.case_id);
				return {
					caseId: row.case_id,
					caseName: row.case_name,
					caseProperties: blank
						? {}
						: Object.fromEntries(caseRowToFormPreload(row)),
				};
			}),
		};
	}
	for (const requirement of required) {
		const parentType = (args.doc.caseTypes ?? []).find(
			(type) => type.name === requirement.caseType,
		)?.parent_type;
		if (!parentType) continue;
		const parents =
			previewMenuCaseContext(
				{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
				requirement.moduleUuid,
				menuSelections,
			).parentCase?.cases.map((choice) => choice.caseId) ?? [];
		if (!parents.length)
			return refuse(
				"This entry point needs a parent case selection. Reload the app and try again.",
			);
		for (const choice of menuSelections[requirement.moduleUuid].cases) {
			const index = args.database.indices.find(
				(index) =>
					index.case_id === choice.caseId &&
					index.identifier === "parent" &&
					index.relationship === "child" &&
					index.depth === 1 &&
					index.target_case_type === parentType,
			);
			if (!index || !parents.includes(index.ancestor_id))
				return refuse(
					"Choose child cases that belong to the selected parent cases.",
				);
		}
	}
	const deviceCases: NavigationDeviceCases = {
		snapshot: args.database,
		caseTypes: args.doc.caseTypes ?? [],
	};
	/* Android ignores display conditions on an entry point (commcare-android
	 * holds no reader of `Endpoint.isRespectRelevancy`); Web Apps keeps them
	 * unless the entry point ignores them. */
	const bypass =
		args.rules.entryPointDisplayConditions === "ignored" ||
		(item.target.kind === "form" &&
			item.entryPoint.ignoreDisplayConditions === true);
	if (!bypass) {
		/* A form off the menu, or inside a module off the menu or under one,
		 * opens from an entry point only when it ignores display conditions. */
		if (
			item.target.kind === "form" &&
			(args.doc.forms[item.target.formUuid]?.hiddenFromMenu === true ||
				moduleEntriesOffTheMenu(args.doc, item.target.moduleUuid))
		)
			return refuse(FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL);
		/* The menus a worker passes to reach the destination: for a form or a
		 * case list, those on the way to the screen that lists it and those
		 * whose condition its row carries; for a menu, those on the way to its
		 * own screen. */
		const gatingModules =
			item.target.kind === "module" &&
			moduleHasOwnScreen(args.doc, item.target.moduleUuid)
				? previewScreenPath(args.doc, {
						kind: "menu",
						moduleUuid: item.target.moduleUuid,
					})
				: previewContributorGatingModules(args.doc, item.target.moduleUuid);
		for (const moduleUuid of gatingModules) {
			const mod = args.doc.modules[moduleUuid];
			if (mod === undefined) continue;
			if (
				moduleDisplayVisibility({
					condition: mod.displayCondition,
					hiddenFromMenu: mod.hiddenFromMenu === true,
					session: args.session,
					types: previewExpressionContext(
						args.doc,
						{
							entity: "module",
							uuid: moduleUuid,
							slot: "module_display_condition",
						},
						args.lookup.kind === "data" ? args.lookup.data : undefined,
					),
					lookup: args.lookup,
					deviceCases,
				}) !== "shown"
			)
				return refuse(
					"This destination is hidden for the selected Preview worker.",
				);
		}
		if (item.target.kind === "form") {
			const selection = previewMenuCaseContext(
				{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
				item.target.moduleUuid,
				menuSelections,
			).selectedCase;
			const selectedCase =
				selection?.cases.length === 1
					? navigationSelectedCase(
							args.doc,
							item.target.moduleUuid,
							item.target.formUuid,
							selection.cases[0].caseId,
							caseListStepSession(args.doc, item.target.moduleUuid, {
								menuSelections,
								caseDatabase: args.database,
								session: args.session,
							}).data,
						)
					: undefined;
			if (
				formDisplayVisibility({
					condition: args.doc.forms[item.target.formUuid].displayCondition,
					hiddenFromMenu:
						args.doc.forms[item.target.formUuid].hiddenFromMenu === true,
					session: args.session,
					types: previewExpressionContext(
						args.doc,
						{
							entity: "form",
							uuid: item.target.formUuid,
							slot: "form_display_condition",
						},
						args.lookup.kind === "data" ? args.lookup.data : undefined,
					),
					selectedCase,
					deviceCases,
					lookup: args.lookup,
				}) !== "shown"
			)
				return refuse(
					"This form is hidden for the selected cases or Preview worker.",
				);
		}
	}
	const target = item.target;
	/* Web Apps' claim frame posts a claim for every chosen case before it
	 * navigates, except in a menu whose forms read the search; Android keeps
	 * only the last command and never reaches the claim. */
	const claimCaseIds =
		args.rules.entryPointClaims === "posted" &&
		!moduleFormsReadSearch(args.doc.modules[target.moduleUuid])
			? required.flatMap(
					(requirement) =>
						menuSelections[requirement.moduleUuid]?.cases.map(
							(choice) => choice.caseId,
						) ?? [],
				)
			: [];
	return {
		kind: "ready",
		claimCaseIds,
		blankCaseIds,
		launch: {
			entryPointUuid: args.entryPointUuid,
			expectedSeq: args.expectedSeq,
			personaUuid: args.personaUuid,
			ignoreDisplayConditions: bypass,
			menuSelections,
			location:
				target.kind === "form"
					? {
							kind: "form",
							moduleUuid: target.moduleUuid,
							formUuid: target.formUuid,
						}
					: target.kind === "case-list"
						? { kind: "cases", moduleUuid: target.moduleUuid }
						: { kind: "module", moduleUuid: target.moduleUuid },
			...(target.kind === "form"
				? {
						formTarget: {
							formUuid: target.formUuid,
							cases:
								previewMenuCaseContext(
									{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
									target.moduleUuid,
									menuSelections,
								).selectedCase?.cases ?? [],
						},
					}
				: {}),
		},
	};
}
