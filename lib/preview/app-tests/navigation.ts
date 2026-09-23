import {
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	caseSelectionMaximum,
	formLaunch,
	menuFormUuidsOf,
	moduleDestination,
	type Uuid,
} from "@/lib/domain";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "../engine/caseDataBindingTypes";
import { formDisplayVisibility } from "../engine/displayConditionEvaluation";
import { previewSessionValues } from "../engine/identity";
import {
	moduleHasChildren,
	previewAutomaticForm,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
	previewModuleVisibility,
} from "../menuProjection";
import type { AppTestContext } from "./context";
import type { AppTestScreen, AppTestState } from "./types";

export function appTestMenus(context: AppTestContext, parent: Uuid | null) {
	const { doc, identity, lookup } = context;
	const visibility = previewModuleVisibility(doc, {
		authoring: false,
		session: previewSessionValues(identity),
		lookup: { kind: "data", data: lookup },
	});
	return previewMenuModuleUuids(doc, parent).map((uuid) => ({
		uuid,
		name: doc.modules[uuid].name,
		visibility: visibility.get(uuid) ?? "hidden",
	}));
}

/** Browser leaf form choosers keep their selection local to CaseListScreen.
 * Only parent-menu selections survive a form entry and module navigation. */
export function appTestMenuSelection(
	context: AppTestContext,
	state: AppTestState,
	moduleUuid: Uuid,
) {
	return state.screen.kind === "menu" &&
		state.screen.moduleUuid === moduleUuid &&
		state.screen.selection !== undefined
		? state.screen.selection
		: previewMenuCaseContext(context.doc, moduleUuid, state.selections)
				.selectedCase;
}

export function appTestForms(
	context: AppTestContext,
	state: AppTestState,
	moduleUuid: Uuid,
	loadingOnly = false,
) {
	const { doc, identity, lookup } = context;
	const mod = doc.modules[moduleUuid];
	const selected = appTestMenuSelection(context, state, moduleUuid)?.cases;
	const properties =
		selected?.length === 1 && caseSelectionCardinality(mod) === "single"
			? selected[0].caseProperties
			: undefined;
	return menuFormUuidsOf(doc, moduleUuid).flatMap((uuid) => {
		const form = doc.forms[uuid];
		if (loadingOnly && !CASE_LOADING_FORM_TYPES.has(form.type)) return [];
		return [
			{
				form,
				visibility: formDisplayVisibility({
					condition: form.displayCondition,
					session: previewSessionValues(identity),
					currentCaseType: mod.caseType,
					caseProjection: properties
						? new Map(Object.entries(properties))
						: undefined,
					lookup: { kind: "data", data: lookup },
				}),
			},
		];
	});
}

/** Follow the same case-parent chain and module landing as Preview. A parent
 * selector must itself be eligible; a requested child never bypasses its gate. */
export function enterAppTestMenu(
	context: AppTestContext,
	state: AppTestState,
	moduleUuid: Uuid,
	returnModules: readonly Uuid[] = [],
): AppTestScreen {
	const { doc } = context;
	const visibility = previewModuleVisibility(doc, {
		authoring: false,
		session: previewSessionValues(context.identity),
		lookup: { kind: "data", data: context.lookup },
	});
	const visited = new Set<Uuid>();
	let current = moduleUuid;
	let onward = returnModules;
	while (true) {
		if (visited.has(current))
			throw new Error("The record-selection path contains a cycle.");
		visited.add(current);
		if (visibility.get(current) !== "shown")
			throw new Error("This worker cannot open the required menu.");
		const caseContext = previewMenuCaseContext(doc, current, state.selections);
		if (caseContext.requiredParentCase) {
			onward = [current, ...onward];
			current = caseContext.requiredParentCase.moduleUuid;
			continue;
		}
		if (onward.length > 0)
			return { kind: "records", moduleUuid: current, returnModules: onward };
		const destination = moduleDestination(
			doc,
			current,
			caseContext.selectedCase !== undefined,
		);
		return destination.screen === "menu"
			? { kind: "menu", moduleUuid: current }
			: { kind: "records", moduleUuid: current };
	}
}

export function enterAppTestForm(
	context: AppTestContext,
	state: AppTestState,
	moduleUuid: Uuid,
	formUuid: Uuid,
): AppTestScreen {
	const entry = appTestForms(context, state, moduleUuid).find(
		(item) => item.form.uuid === formUuid,
	);
	if (entry?.visibility !== "shown")
		throw new Error("This form is not available on the current menu.");
	const selection = appTestMenuSelection(context, state, moduleUuid);
	const needsCase =
		formLaunch({
			formType: entry.form.type,
			moduleHasCaseType: context.doc.modules[moduleUuid].caseType !== undefined,
		}).kind === "select-case-first";
	if (needsCase && !selection) return { kind: "records", moduleUuid, formUuid };
	return {
		kind: "form",
		moduleUuid,
		formUuid,
		caseIds: needsCase ? (selection?.cases.map((row) => row.caseId) ?? []) : [],
		entryCases: state.deviceCases,
	};
}

export function selectAppTestRecords(
	context: AppTestContext,
	state: AppTestState,
	rows: readonly CaseRowWithCalculated[],
): AppTestState {
	const screen = state.screen;
	if (screen.kind !== "records")
		throw new Error("Open a record list before selecting records.");
	const mod = context.doc.modules[screen.moduleUuid];
	if (
		!mod.caseType ||
		rows.length === 0 ||
		rows.length > caseSelectionMaximum(mod)
	)
		throw new Error("Choose the number of records this menu allows.");
	const selections = { ...state.selections };
	const selectsForMenu =
		!!screen.returnModules?.length ||
		(screen.formUuid === undefined &&
			moduleHasChildren(context.doc, screen.moduleUuid));
	const selection = {
		caseType: mod.caseType,
		cases: rows.map((row) => ({
			caseId: row.case_id,
			caseName: row.case_name || "Case",
			caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
		})),
	};
	if (selectsForMenu) {
		selections[screen.moduleUuid] = selection;
		for (const uuid of [
			...previewMenuModuleUuids(context.doc, screen.moduleUuid),
			...previewCaseDescendantModuleUuids(context.doc, mod.caseType),
		])
			delete selections[uuid];
	}
	const next: AppTestState = {
		...state,
		selections,
		screen: { kind: "menu", moduleUuid: screen.moduleUuid, selection },
	};
	if (selectsForMenu) {
		const [target, ...remaining] = screen.returnModules ?? [];
		return {
			...next,
			screen: enterAppTestMenu(
				context,
				next,
				target ?? screen.moduleUuid,
				remaining,
			),
		};
	}
	const forms = appTestForms(context, next, screen.moduleUuid, true);
	if (forms.length === 0) throw new Error("This record list has no next task.");
	const automatic = previewAutomaticForm(forms, screen.formUuid);
	return {
		...next,
		screen:
			automatic === undefined
				? next.screen
				: enterAppTestForm(context, next, screen.moduleUuid, automatic),
	};
}

export function appTestCanContinue(
	context: AppTestContext,
	screen: Extract<AppTestScreen, { kind: "records" }>,
): boolean {
	return (
		!!screen.returnModules?.length ||
		(screen.formUuid === undefined &&
			moduleHasChildren(context.doc, screen.moduleUuid)) ||
		screen.formUuid !== undefined ||
		menuFormUuidsOf(context.doc, screen.moduleUuid).some((uuid) =>
			CASE_LOADING_FORM_TYPES.has(context.doc.forms[uuid].type),
		)
	);
}
