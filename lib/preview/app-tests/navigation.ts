import { workerWording } from "@/lib/doc/localizationWorkspace";
import {
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	caseSelectionMaximum,
	formLaunch,
	localizeTranslationUnit,
	type MenuScreen,
	type MenuScreenEntry,
	menuFormUuidsOf,
	menuScreenOf,
	moduleDestination,
	moduleIsBareCaseList,
	screenChoosesCaseFirst,
	snapshotTranslationUnits,
	type Uuid,
} from "@/lib/domain";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { resolveCaseFormContext } from "@/lib/domain/caseFormContext";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	menuWithInheritedCaseSettings,
	routeContainsForm,
} from "@/lib/domain/listedForms";
import type { Platform } from "@/lib/domain/platforms";
import { previewExpressionContext } from "@/lib/preview/engine/expressionContext";
import type { PreviewEntryChoice } from "@/lib/session/types";
import { EMPTY_AFTER_SUBMIT_STACK } from "../afterSubmitStack";
import { caseListMenuItemSelection } from "../caseListMenuItemRoute";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "../engine/caseDataBindingTypes";
import {
	formDisplayVisibility,
	type NavigationDeviceCases,
	type NavigationItemVisibility,
	type NavigationSelectedCase,
	navigationSelectedCase,
} from "../engine/displayConditionEvaluation";
import {
	caseListStepSession,
	entrySessionData,
	entryWalksChoices,
} from "../engine/entrySessionData";
import { previewSessionValues } from "../engine/identity";
import {
	previewLeafAsksParentCase,
	previewParentCaseBeforeMenu,
	previewParentCaseListHasDetails,
} from "../engine/parentCaseSelection";
import { previousTaskFormSelectors } from "../engine/previousTask";
import {
	combineNavigationVisibility,
	dependentMenuSelectionUuids,
	moduleHasChildren,
	previewCaseListMenuEntry,
	previewContributorVisibility,
	previewEntryBadge,
	previewMenuCaseContext,
	previewModuleOwnVisibility,
	previewModuleVisibility,
	previewRequestedForm,
	previewScreenEntries,
} from "../menuProjection";
import { previewPlatformRules } from "../platform";
import { previewCaseChoiceOf } from "../searchClaims";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";
import type {
	AppTestHistoryEntry,
	AppTestScreen,
	AppTestSessionState,
} from "./types";

/** Where a session of this platform enters the app: Android's home screen,
 *  or the module list on Web Apps, which has no home inside an app. */
export function appTestEntryScreen(platform: Platform): AppTestScreen {
	return previewPlatformRules(platform).appHome === "device-home"
		? { kind: "device-home" }
		: { kind: "home" };
}

/**
 * The screen Back returns to. A form it returns to opens a fresh entry,
 * reading the session's device cases and its search again; that entry is no
 * Register launch, since a launch belongs to the one entry it opened, so the
 * form routes after submit as a form opened any other way does.
 */
export function appTestBackScreen(
	prior: AppTestScreen,
	deviceCases: AppTestSessionState["deviceCases"],
): AppTestScreen {
	if (prior.kind !== "form") return prior;
	const {
		caseListRegistrationLaunch: _ended,
		entry: _retired,
		searchResults: _reread,
		...screen
	} = prior;
	return { ...screen, entryCases: deviceCases };
}

/** A screen the session leaves, kept with the case selections the session
 *  held while it was shown, for Back to return to (`appTestStepBack`). */
export function appTestHistoryEntry(
	screen: AppTestScreen,
	shownWith: AppTestSessionState["selections"],
): AppTestHistoryEntry {
	return { ...screen, shownWith };
}

/**
 * Back: the previous screen (`appTestBackScreen`), with the case selections
 * the session held while it was shown, so every case chosen after it is let
 * go, a parent case asked for after a form's command included, and the next
 * walk past that screen asks for it again. One rule on both platforms:
 * Android's Back is `CommCareSession.stepBack`, which pops each datum
 * collected since until the session waits for the worker again, and Web
 * Apps' Back is the previous address, whose `selections` Formplayer replays
 * (`MenuSessionRunnerService.advanceSessionWithSelections`), as Preview's
 * Back restores the selections its entry was shown with
 * (`lib/routing/previewSelectionsHistory.ts`).
 */
export function appTestStepBack(
	state: AppTestSessionState,
): AppTestSessionState {
	const prior = state.history.at(-1);
	if (!prior) throw new AppTestActionError("There is no previous screen.");
	const { shownWith, ...screen } = prior;
	return {
		...state,
		screen: appTestBackScreen(screen, state.deviceCases),
		selections: shownWith,
		history: state.history.slice(0, -1),
	};
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

/** Badges are evaluated only for commands the session offers. The observation
 * uses the browser's value projector over this test worker's restored rows. */
function appTestBadge(
	context: AppTestContext,
	state: Pick<AppTestSessionState, "deviceCases" | "platform">,
	entry: MenuScreenEntry,
	visibility: NavigationItemVisibility,
	selectedCase?: NavigationSelectedCase,
) {
	if (visibility !== "shown") return {};
	const badge = previewEntryBadge({
		...appTestVisibilityArgs(context, state),
		doc: context.doc,
		entry,
		platform: state.platform,
		selectedCase,
		localizedValues: {
			get: (id) => {
				const unit = snapshotTranslationUnits(context.doc).get(id);
				return (
					unit &&
					localizeTranslationUnit(context.doc, context.language, unit).effective
				);
			},
		},
	});
	return badge ? { badge } : {};
}

/** The menu tiles a home (`null`) or menu screen lists, by the same
 *  projection the browser's screens list them (`previewScreenEntries`). */
export function appTestMenus(
	context: AppTestContext,
	parent: Uuid | null,
	state: Pick<AppTestSessionState, "deviceCases" | "platform">,
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
							...appTestBadge(
								context,
								state,
								entry,
								visibility.get(entry.moduleUuid) ?? "hidden",
							),
							name: workerWording(
								doc,
								context.language,
								generatedWordingId(entry.moduleUuid, "menuTitle"),
							),
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
	const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
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
		selected?.length === 1 &&
		mod !== undefined &&
		caseSelectionCardinality(mod) === "single"
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
		const visibility = combineNavigationVisibility(
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
		);
		return [
			{
				form,
				visibility,
				...appTestBadge(
					context,
					state,
					{ kind: "form", moduleUuid, formUuid: uuid },
					visibility,
					selectedCase,
				),
			},
		];
	});
}

type AppTestRecordsScreen = Extract<AppTestScreen, { kind: "records" }>;

/**
 * The menus whose cases the session still needs before a leaf of the module
 * runs, root first: its parent case's menu where the session holds no such
 * case, that one's where it holds none either, and so on, the selector chain
 * Preview walks (`previewMenuCaseContext`'s `requiredParentCase`). The
 * module and each of them must be shown to the worker.
 */
function appTestParentSelectors(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
): Uuid[] {
	const { doc } = context;
	const visibility = previewModuleVisibility(
		doc,
		appTestVisibilityArgs(context, state),
	);
	const selectors: Uuid[] = [];
	const visited = new Set<Uuid>();
	for (let current: Uuid | undefined = moduleUuid; current !== undefined; ) {
		if (visited.has(current))
			throw new AppTestActionError(
				"The record-selection path contains a cycle.",
			);
		visited.add(current);
		if (visibility.get(current) !== "shown")
			throw new AppTestActionError(
				"This worker cannot open the required menu.",
			);
		if (current !== moduleUuid) selectors.unshift(current);
		current = previewMenuCaseContext(doc, current, state.selections)
			.requiredParentCase?.moduleUuid;
	}
	return selectors;
}

/**
 * The records screen that asks for the first of `selectors`, going on
 * through the rest to `onward`, as Preview's parent case request does
 * (`moduleScreenNavigation.ts::previewParentCaseRequestFor`).
 */
function appTestSelectorScreen(
	selectors: readonly Uuid[],
	onward: readonly Uuid[],
	extra: Pick<AppTestRecordsScreen, "retainedFormTarget" | "resumesList"> = {},
): AppTestRecordsScreen | undefined {
	const [first, ...rest] = selectors;
	return first === undefined
		? undefined
		: {
				kind: "records",
				moduleUuid: first,
				returnModules: [...rest, ...onward],
				...extra,
			};
}

/**
 * Follow the same case-parent chain and module landing as Preview. A menu
 * asks for its parent case before it lists its screen only where Core does
 * (`parentCaseSelection.ts::previewParentCaseBeforeMenu`); a menu that lists
 * an entry asking for no case beside one asking for its parent lists its
 * forms first, and the parent is asked for after the command of the form or
 * case list that needs it (`enterAppTestForm`, `appTestCaseListScreen`). A
 * selector entered on the way (`returnModules`) asks for its own parent case
 * first, as it is entered at its case list. A parent selector must itself be
 * eligible; a requested child never bypasses its gate.
 */
export function enterAppTestMenu(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
	returnModules: readonly Uuid[] = [],
	resumesList?: AppTestRecordsScreen["resumesList"],
): AppTestScreen {
	const { doc } = context;
	const selectors = appTestParentSelectors(context, state, moduleUuid);
	const extra = resumesList === undefined ? {} : { resumesList };
	if (
		returnModules.length > 0 ||
		previewParentCaseBeforeMenu(doc, moduleUuid)
	) {
		const selector = appTestSelectorScreen(
			selectors,
			[moduleUuid, ...returnModules],
			extra,
		);
		if (selector !== undefined) return selector;
	}
	if (returnModules.length > 0)
		return { kind: "records", moduleUuid, returnModules, ...extra };
	const destination = moduleDestination(
		doc,
		moduleUuid,
		previewMenuCaseContext(doc, moduleUuid, state.selections).selectedCase !==
			undefined,
	);
	return destination.screen === "menu"
		? { kind: "menu", moduleUuid }
		: { kind: "records", moduleUuid };
}

/**
 * The screen a menu's case list opens on: `list`, or, where the list asks
 * for its parent case and the session holds none, the parent's list, after
 * which `list` opens with its mark (`resumesList`), as Preview's parent case
 * request resumes the list it was asked from.
 */
export function appTestCaseListScreen(
	context: AppTestContext,
	state: AppTestSessionState,
	list: AppTestRecordsScreen,
): AppTestRecordsScreen {
	if (!previewLeafAsksParentCase(context.doc, list.moduleUuid)) return list;
	return (
		appTestSelectorScreen(
			appTestParentSelectors(context, state, list.moduleUuid),
			[list.moduleUuid],
			{
				resumesList:
					list.openedFrom === undefined ? {} : { openedFrom: list.openedFrom },
			},
		) ?? list
	);
}

/**
 * The parent case a records screen chooses for another menu, where it is a
 * step of a selector chain: the menu whose entry asks for it (the one the
 * chain ends at), and the form chosen before the case where one was.
 */
export function appTestParentRequestOf(
	screen: AppTestRecordsScreen,
): { requestingModuleUuid: Uuid; formUuid?: Uuid } | undefined {
	const requesting =
		screen.retainedFormTarget?.moduleUuid ?? screen.returnModules?.at(-1);
	if (requesting === undefined || requesting === screen.moduleUuid)
		return undefined;
	return {
		requestingModuleUuid: requesting,
		...(screen.retainedFormTarget !== undefined && {
			formUuid: screen.retainedFormTarget.formUuid,
		}),
	};
}

/**
 * Whether a case chosen on a records screen opens its details first: where
 * the list has a details screen and, on a parent's list another menu asked
 * for, the datum it chooses for names one
 * (`parentCaseSelection.ts::previewParentCaseListHasDetails`), as
 * `CaseListScreen` decides it for the browser's row.
 */
export function appTestRecordsHaveDetails(
	context: AppTestContext,
	screen: AppTestRecordsScreen,
	listHasDetails: boolean,
): boolean {
	if (
		resolveCaseFormContext(context.doc.modules, screen.moduleUuid)
			?.inlineModuleUuid
	)
		return false;
	if (screen.formEntry) return screen.formEntry.next.confirms;
	const request = appTestParentRequestOf(screen);
	return request === undefined
		? listHasDetails
		: listHasDetails &&
				previewParentCaseListHasDetails(context.doc, {
					selectorModuleUuid: screen.moduleUuid,
					...request,
				});
}

/** This worker has selected exactly the stored prefix. A repeated list with another
 * selection identity is a fresh screen, even when it shows the very same cases. */
export function appTestFormOpening(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
	formUuid: Uuid,
	choices: readonly PreviewEntryChoice[],
	linkedCases?: AppTestSessionState["deviceCases"],
): AppTestScreen {
	const scoped =
		linkedCases ??
		(state.screen.kind === "menu" || state.screen.kind === "records"
			? state.screen.taskCases
			: undefined);
	const snapshot = scoped ?? state.deviceCases;
	const entry = entrySessionData(context.doc, formUuid, {
		appId: undefined,
		entryKey: "",
		boundCases: [],
		menuSelections: state.selections,
		entryChoices: choices,
		caseDatabase: snapshot,
		lookupData: context.lookup,
		session: previewSessionValues(context.identity, context.device),
	});
	if (entry.nextSelection)
		return {
			kind: "records",
			moduleUuid: entry.nextSelection.moduleUuid,
			formEntry: {
				moduleUuid,
				formUuid,
				choices,
				next: entry.nextSelection,
				values: entry.resolvedEntryValues,
				sessionData: entry.data,
			},
			...(scoped && { taskCases: scoped }),
		};
	const own = ownFormSelectionIndex(context.doc, formUuid);
	const ownChoice =
		own === undefined
			? undefined
			: formCaseSelections(context.doc, formUuid)[own];
	const caseId = ownChoice && entry.reachedCaseIds.get(ownChoice.uuid);
	return {
		kind: "form",
		moduleUuid,
		formUuid,
		caseIds: caseId ? [caseId] : [],
		entryCases: snapshot,
		entryChoices: choices,
		heldEntryValues: entry.resolvedEntryValues,
	};
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
		!routeContainsForm(context.doc, moduleUuid, formUuid)
	)
		throw new AppTestActionError(
			"This form is not available on the current menu.",
		);
	const selection = appTestMenuSelection(context, state, moduleUuid);
	/* A form that keeps its own choices, or whose entry opens a single match
	 * automatically, is walked choice by choice, as Preview walks it
	 * (`entryWalksChoices`); a case this menu already chose is its own. */
	if (
		entry.form.caseSelections !== undefined ||
		entry.form.shadowOf !== undefined ||
		(selection === undefined && entryWalksChoices(context.doc, formUuid))
	)
		return appTestFormOpening(context, state, moduleUuid, formUuid, []);
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
	/* A form whose entry chooses the module's parent case asks for it after
	 * its command where the session holds none, and opens once its own case
	 * is chosen, as Preview's parent case request resumes the form
	 * (`previewLeafAsksParentCase`); a registration or a survey asks for
	 * none. */
	if (
		!retainedCommand &&
		previewLeafAsksParentCase(context.doc, moduleUuid, formUuid)
	) {
		const selector = appTestSelectorScreen(
			appTestParentSelectors(context, state, moduleUuid),
			[moduleUuid],
			{ retainedFormTarget: { moduleUuid, formUuid } },
		);
		if (selector !== undefined) return selector;
	}
	const needsCase =
		formLaunch({
			formType: entry.form.type,
			moduleHasCaseType:
				menuWithInheritedCaseSettings(context.doc, moduleUuid)?.caseType !==
				undefined,
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
	if (screen.formEntry) {
		const entry = screen.formEntry;
		if (rows.length !== 1)
			throw new AppTestActionError("Choose one record for this form.");
		const chosen = {
			...previewCaseChoiceOf(rows[0]),
			selectionUuid: entry.next.selectionUuid,
			earlierValues: entry.values,
		};
		return {
			...state,
			screen: appTestFormOpening(
				context,
				state,
				entry.moduleUuid,
				entry.formUuid,
				[...entry.choices, chosen],
			),
		};
	}
	/* A route listing another menu's forms takes its case type and selection from its source. */
	const mod = menuWithInheritedCaseSettings(context.doc, screen.moduleUuid);
	if (
		!mod?.caseType ||
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
		for (const uuid of dependentMenuSelectionUuids(
			context.doc,
			screen.moduleUuid,
		))
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
		/* A chain a case list asked for opens that list once its last
		 * parent case is chosen. */
		if (
			screen.resumesList !== undefined &&
			target !== undefined &&
			remaining.length === 0
		)
			return {
				...next,
				screen: { kind: "records", moduleUuid: target, ...screen.resumesList },
			};
		return {
			...next,
			screen: enterAppTestMenu(
				context,
				next,
				target ?? screen.moduleUuid,
				remaining,
				screen.resumesList,
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
	/* The form chosen before the case opens, and no menu is listed, so no
	 * condition is read (`previewRequestedForm`); otherwise the menu lists its
	 * forms, however many it shows. */
	const requested = previewRequestedForm(
		menuFormUuidsOf(context.doc, screen.moduleUuid).filter((uuid) => {
			const type = context.doc.forms[uuid]?.type;
			return type !== undefined && CASE_LOADING_FORM_TYPES.has(type);
		}),
		screen.formUuid,
	);
	if (requested !== undefined)
		return {
			...next,
			screen: enterAppTestForm(context, next, screen.moduleUuid, requested),
		};
	if (appTestForms(context, next, screen.moduleUuid, true).length === 0)
		throw new AppTestActionError("This record list has no next task.");
	return next;
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
		screen.formEntry !== undefined ||
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
 * the forms (`menuProjection.ts::previewCaseListMenuEntry`): only while it
 * still needs a case the screen has not chosen, so on a case-first screen
 * only once its case is chosen and only where the entry goes on past that
 * case. Choosing it opens its case list.
 */
export function appTestCaseListMenuEntry(
	context: AppTestContext,
	state: AppTestSessionState,
	moduleUuid: Uuid,
) {
	/* The screen that lists the entry chose its case, if it did: its own
	 * menu's, or the menu above's where its menu shows its forms there. */
	const screen = menuScreenOf(context.doc, moduleUuid);
	return previewCaseListMenuEntry(context.doc, moduleUuid, {
		isCaseFirst: screenChoosesCaseFirst(context.doc, screen),
		hasSelectedCase:
			screen.kind === "menu" &&
			appTestMenuSelection(context, state, screen.moduleUuid) !== undefined,
	});
}

/**
 * Where choosing a case from a case list menu entry lands
 * (`caseListMenuItemRoute.ts::caseListMenuItemSelection`): the entry holds no
 * form, so on Web Apps Formplayer steps back over the choice and, since the
 * entry still needs it, the list shows again (`MenuSession.getNextScreen`,
 * `isViewCommand` → `stepBack`); Android ends the session at the phone's home
 * screen. `before` is the state at the list with nothing chosen.
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
		screen.formEntry !== undefined ||
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
