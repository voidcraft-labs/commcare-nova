import {
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	caseSelectionMaximum,
	childModuleUuids,
	formLaunch,
	type MenuScreen,
	menuFormUuidsOf,
	menuScreenOf,
	moduleDestination,
	moduleIsBareCaseList,
	screenChoosesCaseFirst,
	type Uuid,
} from "@/lib/domain";
import { projectLocalizedModule } from "@/lib/domain/localizedBlueprintProjection";
import type { Platform } from "@/lib/domain/platforms";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import { EMPTY_AFTER_SUBMIT_STACK } from "../afterSubmitStack";
import { caseListMenuItemSelection } from "../caseListMenuItemRoute";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "../engine/caseDataBindingTypes";
import {
	formDisplayVisibility,
	type NavigationDeviceCases,
	navigationSelectedCase,
} from "../engine/displayConditionEvaluation";
import { caseListStepSession } from "../engine/entrySessionData";
import { previewSessionValues } from "../engine/identity";
import { previousTaskFormSelectors } from "../engine/previousTask";
import {
	combineNavigationVisibility,
	moduleHasChildren,
	previewAutomaticForm,
	previewCaseDescendantModuleUuids,
	previewCaseListMenuEntry,
	previewContributorVisibility,
	previewMenuCaseContext,
	previewModuleOwnVisibility,
	previewModuleVisibility,
	previewScreenEntries,
} from "../menuProjection";
import { previewPlatformRules } from "../platform";
import { previewCaseChoiceOf } from "../searchClaims";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";
import type { AppTestScreen, AppTestSessionState } from "./types";

/** Where a session of this platform enters the app: Android's home screen,
 *  or the module list on Web Apps, which has no home inside an app. */
export function appTestEntryScreen(platform: Platform): AppTestScreen {
	return previewPlatformRules(platform).appHome === "device-home"
		? { kind: "device-home" }
		: { kind: "home" };
}

/** The session's device cases, as a navigation condition reads them. */
function appTestDeviceCases(
	context: AppTestContext,
	state: Pick<AppTestSessionState, "deviceCases">,
): NavigationDeviceCases {
	return {
		snapshot: state.deviceCases,
		caseTypes: context.doc.caseTypes ?? [],
	};
}

/** The screen a home or menu screen draws: the app's first menu for Home
 *  (`null`), else that menu's own screen. */
function appTestMenuScreen(parent: Uuid | null): MenuScreen {
	return parent === null
		? { kind: "first-menu" }
		: { kind: "menu", moduleUuid: parent };
}

/** The arguments every running-menu visibility read takes. */
function appTestVisibilityArgs(
	context: AppTestContext,
	state: Pick<AppTestSessionState, "deviceCases">,
) {
	return {
		authoring: false,
		session: previewSessionValues(context.identity, context.device),
		lookup: { kind: "data", data: context.lookup },
		deviceCases: appTestDeviceCases(context, state),
	} as const;
}

/** The menu tiles a home (`null`) or menu screen lists, by the same
 *  projection the browser's screens list them (`previewScreenEntries`). */
export function appTestMenus(
	context: AppTestContext,
	parent: Uuid | null,
	state: Pick<AppTestSessionState, "deviceCases">,
) {
	const { doc } = context;
	const visibility = previewModuleVisibility(
		doc,
		appTestVisibilityArgs(context, state),
	);
	return previewScreenEntries(doc, appTestMenuScreen(parent)).flatMap(
		(entry) =>
			entry.kind === "menu"
				? [
						{
							uuid: entry.moduleUuid,
							name: projectLocalizedModule(
								doc,
								context.language,
								entry.moduleUuid,
							)?.name,
							visibility: visibility.get(entry.moduleUuid) ?? "hidden",
						},
					]
				: [],
	);
}

/** The forms a home (`null`) or menu screen lists, each with the menu that
 *  holds it: its own menu's forms and those of every menu that shows its
 *  forms there (`previewScreenEntries`). */
export function appTestScreenForms(
	context: AppTestContext,
	state: AppTestSessionState,
	parent: Uuid | null,
) {
	const formsByModule = new Map<Uuid, ReturnType<typeof appTestForms>>();
	return previewScreenEntries(context.doc, appTestMenuScreen(parent)).flatMap(
		(entry) => {
			if (entry.kind !== "form") return [];
			let forms = formsByModule.get(entry.moduleUuid);
			if (forms === undefined) {
				forms = appTestForms(context, state, entry.moduleUuid);
				formsByModule.set(entry.moduleUuid, forms);
			}
			const listed = forms.find((item) => item.form.uuid === entry.formUuid);
			return listed === undefined
				? []
				: [{ ...listed, moduleUuid: entry.moduleUuid }];
		},
	);
}

/** The case list entries a home (`null`) or menu screen lists, each with its
 *  menu and how the screen shows it (`previewCaseListMenuEntry`), shown or
 *  hidden by the menus whose condition it carries. */
export function appTestScreenCaseLists(
	context: AppTestContext,
	state: AppTestSessionState,
	parent: Uuid | null,
) {
	const own = previewModuleOwnVisibility(
		context.doc,
		appTestVisibilityArgs(context, state),
	);
	return previewScreenEntries(context.doc, appTestMenuScreen(parent)).flatMap(
		(screenEntry) => {
			if (screenEntry.kind !== "case-list") return [];
			const entry = appTestCaseListMenuEntry(
				context,
				state,
				screenEntry.moduleUuid,
			);
			return entry === undefined
				? []
				: [
						{
							moduleUuid: screenEntry.moduleUuid,
							entry,
							visibility: previewContributorVisibility(
								context.doc,
								own,
								screenEntry.moduleUuid,
							),
						},
					];
		},
	);
}

/** Browser leaf form choosers keep their selection local to CaseListScreen.
 * Only parent-menu selections survive a form entry and module navigation. */
export function appTestMenuSelection(
	context: AppTestContext,
	state: AppTestSessionState,
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
	state: AppTestSessionState,
	moduleUuid: Uuid,
	loadingOnly = false,
) {
	const { doc, identity, lookup } = context;
	const mod = doc.modules[moduleUuid];
	/* A form's row shows while every menu whose condition it carries does: its
	 * own, and its parent where its menu shows its forms above. */
	const contributor = previewContributorVisibility(
		doc,
		previewModuleOwnVisibility(doc, appTestVisibilityArgs(context, state)),
		moduleUuid,
	);
	const selected = appTestMenuSelection(context, state, moduleUuid)?.cases;
	const leafChooser =
		state.screen.kind === "menu" &&
		state.screen.moduleUuid === moduleUuid &&
		state.screen.selection !== undefined;
	const chosenCaseId =
		selected?.length === 1 && caseSelectionCardinality(mod) === "single"
			? selected[0].caseId
			: undefined;
	return menuFormUuidsOf(doc, moduleUuid).flatMap((uuid) => {
		const form = doc.forms[uuid];
		if ((loadingOnly || leafChooser) && !CASE_LOADING_FORM_TYPES.has(form.type))
			return [];
		const selectedCase =
			chosenCaseId === undefined
				? undefined
				: navigationSelectedCase(
						doc,
						moduleUuid,
						uuid,
						chosenCaseId,
						caseListStepSession(doc, moduleUuid, {
							menuSelections: state.selections,
							caseDatabase: appTestDeviceCases(context, state).snapshot,
							session: previewSessionValues(identity, context.device),
						}).data,
					);
		return [
			{
				form,
				visibility: combineNavigationVisibility(
					contributor,
					formDisplayVisibility({
						condition: form.displayCondition,
						hiddenFromMenu: form.hiddenFromMenu === true,
						session: previewSessionValues(identity, context.device),
						types: previewExpressionContext(
							doc,
							{ entity: "form", uuid, slot: "form_display_condition" },
							lookup,
						),
						selectedCase,
						deviceCases: appTestDeviceCases(context, state),
						lookup: { kind: "data", data: lookup },
					}),
				),
			},
		];
	});
}

/** Follow the same case-parent chain and module landing as Preview. A parent
 * selector must itself be eligible; a requested child never bypasses its gate. */
export function enterAppTestMenu(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
	returnModules: readonly Uuid[] = [],
): AppTestScreen {
	const { doc } = context;
	const visibility = previewModuleVisibility(doc, {
		authoring: false,
		session: previewSessionValues(context.identity, context.device),
		lookup: { kind: "data", data: context.lookup },
		deviceCases: appTestDeviceCases(context, state),
	});
	const visited = new Set<Uuid>();
	let current = moduleUuid;
	let onward = returnModules;
	while (true) {
		if (visited.has(current))
			throw new AppTestActionError(
				"The record-selection path contains a cycle.",
			);
		visited.add(current);
		if (visibility.get(current) !== "shown")
			throw new AppTestActionError(
				"This worker cannot open the required menu.",
			);
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
	state: AppTestSessionState,
	moduleUuid: Uuid,
	formUuid: Uuid,
	retainedCommand = false,
): AppTestScreen {
	const entry = retainedCommand
		? { form: context.doc.forms[formUuid], visibility: "shown" }
		: appTestForms(context, state, moduleUuid).find(
				(item) => item.form.uuid === formUuid,
			);
	if (
		entry?.visibility !== "shown" ||
		!entry.form ||
		!(context.doc.formOrder[moduleUuid] ?? []).includes(formUuid)
	)
		throw new AppTestActionError(
			"This form is not available on the current menu.",
		);
	const selection = appTestMenuSelection(context, state, moduleUuid);
	if (state.screen.kind === "menu" && state.screen.taskCases) {
		const [first, ...remaining] = previousTaskFormSelectors(
			context.doc,
			formUuid,
			selection
				? { ...state.selections, [moduleUuid]: selection }
				: state.selections,
		);
		if (first !== undefined)
			return {
				kind: "records",
				moduleUuid: first,
				...(first === moduleUuid && { formUuid }),
				returnModules: remaining,
				retainedFormTarget: { moduleUuid, formUuid },
				taskCases: state.screen.taskCases,
			};
	}
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
		entryCases:
			state.screen.kind === "menu"
				? (state.screen.taskCases ?? state.deviceCases)
				: state.deviceCases,
	};
}

export function selectAppTestRecords(
	context: AppTestContext,
	state: AppTestSessionState,
	rows: readonly CaseRowWithCalculated[],
): AppTestSessionState {
	const screen = state.screen;
	if (screen.kind !== "records")
		throw new AppTestActionError(
			"Open a record list before selecting records.",
		);
	const mod = context.doc.modules[screen.moduleUuid];
	if (
		!mod.caseType ||
		rows.length === 0 ||
		rows.length > caseSelectionMaximum(mod)
	)
		throw new AppTestActionError(
			"Choose the number of records this menu allows.",
		);
	const selections = { ...state.selections };
	const selectsForMenu =
		!!screen.returnModules?.length ||
		(screen.retainedFormTarget !== undefined &&
			screen.retainedFormTarget.moduleUuid !== screen.moduleUuid) ||
		(screen.formUuid === undefined &&
			moduleHasChildren(context.doc, screen.moduleUuid));
	const selection = {
		caseType: mod.caseType,
		cases: rows.map((row) => ({
			...previewCaseChoiceOf(row),
			caseName: row.case_name || "Case",
			caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
		})),
	};
	if (selectsForMenu) {
		selections[screen.moduleUuid] = selection;
		for (const uuid of [
			...childModuleUuids(context.doc, screen.moduleUuid),
			...previewCaseDescendantModuleUuids(context.doc, mod.caseType),
		])
			delete selections[uuid];
	}
	const next: AppTestSessionState = {
		...state,
		selections,
		screen: {
			kind: "menu",
			moduleUuid: screen.moduleUuid,
			selection,
			taskCases: screen.taskCases,
		},
	};
	if (selectsForMenu) {
		const [target, ...remaining] = screen.returnModules ?? [];
		if (screen.retainedFormTarget)
			return {
				...next,
				screen: target
					? {
							kind: "records",
							moduleUuid: target,
							returnModules: remaining,
							retainedFormTarget: screen.retainedFormTarget,
							taskCases: screen.taskCases,
							...(target === screen.retainedFormTarget.moduleUuid && {
								formUuid: screen.retainedFormTarget.formUuid,
							}),
						}
					: enterAppTestForm(
							context,
							next,
							screen.retainedFormTarget.moduleUuid,
							screen.retainedFormTarget.formUuid,
							true,
						),
			};
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
	if (screen.retainedFormTarget)
		return {
			...next,
			screen: enterAppTestForm(
				context,
				next,
				screen.retainedFormTarget.moduleUuid,
				screen.retainedFormTarget.formUuid,
				true,
			),
		};
	/* A case list menu entry's list routes its choice itself
	 * (`caseListMenuItemLanding`); the callers ask before selecting. */
	if (isCaseListMenuItemList(context, screen))
		throw new AppTestActionError(
			"A case list opened from its menu entry opens no form.",
		);
	const forms = appTestForms(context, next, screen.moduleUuid, true);
	if (forms.length === 0)
		throw new AppTestActionError("This record list has no next task.");
	const automatic = previewAutomaticForm(forms, screen.formUuid);
	return {
		...next,
		screen:
			automatic === undefined
				? next.screen
				: enterAppTestForm(context, next, screen.moduleUuid, automatic),
	};
}

/**
 * Whether a records screen is a case list menu entry's list, whose chosen
 * case takes the entry's route rather than opening a form: one the menu's
 * entry opened, or the landing of a bare case list (a case list menu entry
 * and no forms or child menus, whose menu is its list). A list a form, a
 * parent selection or a retained command opened is not.
 */
export function isCaseListMenuItemList(
	context: AppTestContext,
	screen: Extract<AppTestScreen, { kind: "records" }>,
): boolean {
	if (
		screen.formUuid !== undefined ||
		(screen.returnModules?.length ?? 0) > 0 ||
		screen.retainedFormTarget !== undefined
	)
		return false;
	if (screen.openedFrom === "case-list-menu-item") return true;
	const mod = context.doc.modules[screen.moduleUuid];
	return (
		mod?.caseType !== undefined &&
		moduleIsBareCaseList(context.doc, screen.moduleUuid) &&
		!moduleHasChildren(context.doc, screen.moduleUuid)
	);
}

/**
 * The module's case list entry as the screen that lists it shows it, after
 * the forms (`menuProjection.ts::previewCaseListMenuEntry`): on a case-first
 * screen only once its case is chosen, when choosing it is the selection
 * itself.
 */
export function appTestCaseListMenuEntry(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
) {
	return previewCaseListMenuEntry(context.doc, moduleUuid, {
		isCaseFirst: screenChoosesCaseFirst(
			context.doc,
			menuScreenOf(context.doc, moduleUuid),
		),
		hasSelectedCase:
			appTestMenuSelection(context, state, moduleUuid) !== undefined,
	});
}

/**
 * Where choosing a case from a case list menu entry lands
 * (`caseListMenuItemRoute.ts::caseListMenuItemSelection`): the entry holds no
 * form, so on Web Apps Formplayer steps back over the choice and the screen
 * before it shows (`MenuSession.getNextScreen`, `isViewCommand` → `stepBack`);
 * Android ends the session at the phone's home screen. `before` is the state
 * at the screen before the choice: the list with nothing chosen in a
 * forms-first menu, the menu in a case-first one.
 */
export function caseListMenuItemLanding(
	context: AppTestContext,
	before: AppTestSessionState,
): AppTestSessionState {
	const route = caseListMenuItemSelection(context.rules);
	switch (route.kind) {
		case "device-home":
			return {
				...before,
				screen: { kind: "device-home" },
				history: [],
				selections: {},
				afterSubmitStack: EMPTY_AFTER_SUBMIT_STACK,
			};
		case "step-back":
			return before;
	}
}

export function appTestCanContinue(
	context: AppTestContext,
	screen: Extract<AppTestScreen, { kind: "records" }>,
): boolean {
	return (
		!!screen.returnModules?.length ||
		isCaseListMenuItemList(context, screen) ||
		(screen.formUuid === undefined &&
			moduleHasChildren(context.doc, screen.moduleUuid)) ||
		screen.formUuid !== undefined ||
		menuFormUuidsOf(context.doc, screen.moduleUuid).some((uuid) =>
			CASE_LOADING_FORM_TYPES.has(context.doc.forms[uuid].type),
		)
	);
}
