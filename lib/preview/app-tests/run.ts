import type { AppTestScope } from "@/lib/db/appTests";
import {
	assignedLocationUuids,
	caseSelectionCardinality,
	moduleFormsReadSearch,
	orderedColumns,
	orderedOrganizationLevels,
	type Uuid,
} from "@/lib/domain";
import { languageDirection } from "@/lib/domain/languageRegistry";
import {
	effectiveAppLocalization,
	parseLanguageTag,
} from "@/lib/domain/localization";
import {
	projectLocalizedAppName,
	projectLocalizedForm,
	projectLocalizedModule,
} from "@/lib/domain/localizedBlueprintProjection";
import { PLATFORM_LABELS } from "@/lib/domain/platforms";
import { locationFixtureRows } from "@/lib/organization/footprint";
import type {
	PreviewCaseChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { EMPTY_AFTER_SUBMIT_STACK } from "../afterSubmitStack";
import { caseListMenuItemDetailAction } from "../caseListMenuItemRoute";
import { caseListStep } from "../caseListPhase";
import { caseSelectionRowAction } from "../caseSelectionNavigation";
import { deviceHomeButtons } from "../deviceHome";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import { evaluateForm } from "../engine/evaluateForm";
import { appReadsPlaces } from "../engine/expressionCaseReads";
import { availablePages } from "../engine/sectionPaging";
import {
	recordsReadSearch,
	searchedReading,
	serverSearchResults,
} from "../engine/serverSearchRead";
import {
	type CaseDatabaseSnapshot,
	formReadsSearchResults,
	type SearchResultsSnapshot,
} from "../engine/xpathInstances";
import { runtimeLanguage, runtimeMessage } from "../runtimeMessages";
import {
	claimableCaseIds,
	claimPostsAtResult,
	formEntryClaimChoices,
	previewCaseChoiceOf,
} from "../searchClaims";
import { projectWorkerModule } from "../workerModule";
import type { AppTestContext } from "./context";
import { appTestCellProjector, appTestDetails } from "./details";
import { AppTestActionError, expectedAppTestRefusal } from "./errors";
import {
	appTestBackScreen,
	appTestCanContinue,
	appTestCaseListMenuEntry,
	appTestEntryScreen,
	appTestMenuSelection,
	appTestMenus,
	appTestScreenCaseLists,
	appTestScreenForms,
	caseListMenuItemLanding,
	enterAppTestForm,
	enterAppTestMenu,
	isCaseListMenuItemList,
	selectAppTestRecords,
} from "./navigation";
import { appTestRecords, prepareAppTestRecords } from "./records";
import { submitAppTest } from "./submission";
import type {
	AppTestAction,
	AppTestScreen,
	AppTestSessionState,
} from "./types";

type Scope = AppTestScope & {
	role: string;
	blueprintSeq: number;
	blueprintDigest: string;
};
type Observation = Record<string, unknown>;
type FormScreen = Extract<AppTestScreen, { kind: "form" }>;
type CompletedFormObservation = {
	readonly screen: FormScreen;
	readonly result: Awaited<ReturnType<typeof evaluateForm>>;
};

/** The entry's device world: its cases and, for an app whose forms read
 * places, the worker's `locations` fixture, which the session's restore
 * delivers beside them (as Preview's snapshot carries it). */
function appTestEntryCases(
	context: AppTestContext,
	state: AppTestSessionState,
	cases: CaseDatabaseSnapshot,
): CaseDatabaseSnapshot {
	if (!appReadsPlaces(context.doc)) return cases;
	const persona =
		state.personaUuid === null
			? undefined
			: context.doc.personas?.[state.personaUuid];
	return {
		...cases,
		locations:
			persona === undefined ||
			orderedOrganizationLevels(context.doc).length === 0
				? []
				: locationFixtureRows(context.doc, persona, context.locations),
	};
}

/**
 * What the search of a menu whose forms read the search returned to a form of
 * it that reads it: the latest search this session ran on that module's records,
 * read again unpaged and capped as Preview's form reads it
 * (`searchResultsSnapshot.ts`). A form reached without that search has none
 * to read, which the device never allows.
 */
async function appTestSearchResults(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	screen: FormScreen,
): Promise<SearchResultsSnapshot | undefined> {
	const mod = context.doc.modules[screen.moduleUuid];
	if (
		mod?.caseType === undefined ||
		!moduleFormsReadSearch(mod) ||
		!formReadsSearchResults(context.doc, screen.formUuid)
	)
		return undefined;
	const refused = () =>
		new AppTestActionError(
			`${runtimeMessage(context.language, "searchResultsRefusalTitle")}. ${runtimeMessage(context.language, "searchResultsRefusalBody")}`,
		);
	const searchedScreen = [...state.history]
		.reverse()
		.find(
			(prior): prior is Extract<AppTestScreen, { kind: "records" }> =>
				prior.kind === "records" &&
				prior.moduleUuid === screen.moduleUuid &&
				(prior.searchAnswers !== undefined ||
					prior.registeredCaseId !== undefined),
		);
	if (searchedScreen === undefined) throw refused();
	const { read, refusal } = await prepareAppTestRecords(context, scope, {
		...state,
		screen: searchedScreen,
	});
	if (refusal !== undefined) throw new AppTestActionError(refusal);
	const found = await serverSearchResults(context.store, read);
	if (found === undefined) throw refused();
	return found;
}

/**
 * The world a form evaluation of this session reads, and the form screen
 * holding what the module's search returned to the entry. That snapshot is
 * taken once, at the entry's first evaluation, and every later step and the
 * submission read the one the screen holds, as Preview's form keeps the
 * snapshot it opened with (`hooks/useSearchResultsSnapshot.ts`). A new entry
 * (Back to a form, a linked form, another search) carries none and takes its
 * own.
 */
async function appTestFormContext(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	screen: FormScreen,
) {
	const searchResults =
		screen.searchResults ??
		(await appTestSearchResults(context, scope, state, screen));
	return {
		screen: searchResults === undefined ? screen : { ...screen, searchResults },
		formContext: {
			identity: context.identity,
			device: context.device,
			cases: appTestEntryCases(context, state, screen.entryCases),
			lookup: context.lookup,
			entry: screen.entry,
			captureEntry: true,
			session: { appId: scope.appId, menuSelections: state.selections },
			...(searchResults === undefined ? {} : { searchResults }),
		},
	};
}

async function observeScreen(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	completedForm?: CompletedFormObservation,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	const screen = state.screen;
	if (completedForm && completedForm.screen !== screen)
		throw new Error(
			"A completed form observation belongs to a different screen.",
		);
	const persona =
		state.personaUuid === null
			? undefined
			: context.doc.personas?.[state.personaUuid];
	const worker = {
		personaUuid: state.personaUuid,
		name:
			state.personaUuid === null
				? "Myself"
				: context.doc.personas?.[state.personaUuid]?.name,
		role: persona?.userTypeUuid
			? context.doc.userTypes?.[persona.userTypeUuid]?.name
			: undefined,
		places: assignedLocationUuids(persona?.locations).map((uuid) => ({
			uuid,
			name: context.locations.find((place) => place.id === uuid)?.name,
			testOnly: context.testPlaceIds.includes(uuid),
		})),
		assignmentTestOnly:
			state.personaUuid !== null &&
			context.testAssignmentPersonaIds.includes(state.personaUuid),
	};
	switch (screen.kind) {
		case "device-home":
			return {
				state,
				observation: {
					screen: "device-home",
					name: projectLocalizedAppName(context.doc, context.language),
					worker,
					buttons: deviceHomeButtons(
						context.doc.appSettings,
						context.language,
					).map(({ label, available, reason }) => ({
						label,
						available,
						...(reason === undefined ? {} : { reason }),
					})),
				},
			};
		case "home":
			return {
				state,
				observation: {
					screen: "home",
					name: projectLocalizedAppName(context.doc, context.language),
					worker,
					identities: Object.values(context.doc.personas ?? {}).map(
						(persona) => ({ uuid: persona.uuid, name: persona.name }),
					),
					menus: appTestMenus(context, null, state),
					/* The forms and case lists of menus that show their forms on
					 * the app's first menu, listed there in place. */
					forms: screenFormsObservation(context, state, null),
					caseLists: screenCaseListsObservation(context, state, null),
				},
			};
		case "menu":
			return {
				state,
				observation: {
					screen: "menu",
					name: projectLocalizedModule(
						context.doc,
						context.language,
						screen.moduleUuid,
					)?.name,
					worker,
					menus: appTestMenus(context, screen.moduleUuid, state),
					forms: screenFormsObservation(context, state, screen.moduleUuid),
					/* The case lists of menus that show their forms on this
					 * screen; the menu's own is `caseListEntry`. */
					caseLists: screenCaseListsObservation(
						context,
						state,
						screen.moduleUuid,
					).filter((item) => item.menuUuid !== screen.moduleUuid),
					/* The module's case list menu entry, listed after the forms;
					 * the `records` action chooses it. */
					caseListEntry: (() => {
						const entry = appTestCaseListMenuEntry(
							context,
							state,
							screen.moduleUuid,
						);
						const ownLabel =
							context.doc.modules[screen.moduleUuid].caseListMenuItem?.label;
						return entry === undefined
							? undefined
							: {
									name:
										ownLabel ??
										projectLocalizedModule(
											context.doc,
											context.language,
											screen.moduleUuid,
										)?.name,
									opens:
										entry.action === "selection" ? "chosen-case" : "case-list",
								};
					})(),
					recordsAvailable:
						context.doc.modules[screen.moduleUuid].caseType !== undefined,
					selected: appTestMenuSelection(context, state, screen.moduleUuid)
						?.cases,
				},
			};
		case "after-submit":
			return {
				state,
				observation: {
					screen: "after-submit",
					worker,
					savedInTest: true,
					nextTaskError: screen.message,
				},
			};
		case "records": {
			const read = await appTestRecords(context, scope, state);
			const search = read.search;
			const mod = projectWorkerModule(
				context.doc,
				context.language,
				screen.moduleUuid,
			);
			if (!mod) throw new AppTestActionError("This menu is unavailable.");
			const registration = read.registration;
			const cells = appTestCellProjector(
				context,
				screen.moduleUuid,
				"list",
				searchedReading(read.searched),
			);
			return {
				state: read.state,
				observation: {
					screen: caseListStep({
						workflow: search.workflow,
						formsReadSearch: search.formsReadSearch,
						searchRelevant: search.relevant,
						hasSubmitted: search.hasSubmitted,
						submittedFoundNothing: read.result?.kind === "empty",
						rules: context.rules,
					}),
					worker,
					name: mod.name,
					search: search.relevant
						? {
								questions: (mod.caseListConfig?.searchInputs ?? [])
									.filter((input) => input.kind !== "hidden")
									.map((input) => ({
										name: input.name,
										label: input.label,
										type: input.type,
										hint: input.hint,
									})),
								answers: search.draft,
								errors: search.errors,
							}
						: undefined,
					results: read.result,
					renderedResults:
						read.result?.kind === "rows"
							? {
									rows: read.result.rows.map((row) => ({
										recordId: row.case_id,
										cells: cells(row),
									})),
									groups: read.result.grouped?.groups.map((group) => ({
										key: group.key,
										selectedRecordId: group.rows[0]?.case_id,
										recordIds: group.rows.map((row) => row.case_id),
									})),
								}
							: undefined,
					registration: registration
						? { uuid: registration.form.uuid, name: registration.form.name }
						: undefined,
				},
			};
		}
		case "details": {
			const read = await appTestDetails(context, scope, state);
			return {
				state,
				observation: {
					screen: "details",
					worker,
					name: projectLocalizedModule(
						context.doc,
						context.language,
						screen.moduleUuid,
					)?.name,
					record: read.result.kind === "row" ? read.result.row : undefined,
					unavailable: read.result.kind !== "row",
					fields: read.fields,
					canContinue:
						read.result.kind === "row" &&
						appTestCanContinue(context, screen.source),
					/* What `continue` presses here: Android's Done on a case list
					 * menu entry's detail, which returns to the list. */
					...(isCaseListMenuItemList(context, screen.source) && {
						continueLabel: runtimeMessage(
							context.language,
							caseListMenuItemDetailAction(context.rules).message,
						),
					}),
					actions:
						read.result.kind === "row" &&
						appTestCanContinue(context, screen.source)
							? ["continue", "back", "home"]
							: ["back", "home"],
				},
			};
		}
		case "form": {
			let renderedScreen = screen;
			let evaluated: Awaited<ReturnType<typeof evaluateForm>>;
			if (completedForm) evaluated = completedForm.result;
			else {
				const held = await appTestFormContext(context, scope, state, screen);
				renderedScreen = held.screen;
				evaluated = await evaluateForm(
					context.doc,
					{
						formUuid: screen.formUuid,
						language: context.language,
						caseIds: screen.caseIds,
						answers: [],
						searchAnswers: screen.searchAnswers,
					},
					held.formContext,
				);
			}
			/* The form's pages are its screens on the session's platform: one
			 * on Web Apps, so no page turn is offered there. */
			const pages = availablePages(evaluated.screens);
			const currentPage = pages.findIndex((page) => page.current);
			return {
				state: {
					...state,
					screen: { ...renderedScreen, entry: evaluated.entry },
				},
				observation: {
					screen: "form",
					worker,
					name: projectLocalizedForm(
						context.doc,
						context.language,
						screen.formUuid,
					)?.name,
					questions: evaluated.fields.filter((field) => field.onCurrentPage),
					presentation: {
						...evaluated.presentation,
						nodes: evaluated.presentation.nodes.filter(
							(node) => node.onCurrentPage,
						),
					},
					sections: evaluated.sections,
					pageNavigation: {
						canNext: currentPage >= 0 && currentPage + 1 < pages.length,
						canPrevious: currentPage > 0,
					},
					canSubmit: evaluated.canSubmit,
					valid: evaluated.valid,
					submission: "Not submitted",
				},
			};
		}
	}
}

/** Every screen states its language and current route without dumping a graph. */
export async function observeAppTest(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	return observeAppTestWithEvaluation(context, scope, state);
}

async function observeAppTestWithEvaluation(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	completedForm?: CompletedFormObservation,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	const result = await observeScreen(context, scope, state, completedForm);
	const screen = result.state.screen;
	const identity = parseLanguageTag(context.language);
	const entry = appTestEntryScreen(result.state.platform).kind;
	const actions = [
		"observe",
		"identity",
		"language",
		"sync",
		"finish",
		...(screen.kind !== entry && screen.kind !== "device-home" ? ["home"] : []),
		...(result.state.history.length ? ["back", "routeBack"] : []),
	];
	/* Android's home screen: Start opens the module list. */
	if (screen.kind === "device-home") actions.push("continue");
	if (screen.kind === "home" || screen.kind === "menu") actions.push("menu");
	if (screen.kind === "menu") {
		if ((result.observation.forms as unknown[] | undefined)?.length)
			actions.push("form");
		if (result.observation.recordsAvailable) actions.push("records");
	}
	if (screen.kind === "records") {
		if (result.observation.search) actions.push("search");
		if (
			result.observation.screen === "results" ||
			result.observation.screen === "browse"
		)
			actions.push("select", "page");
		if (result.observation.registration) actions.push("form");
	}
	if (screen.kind === "details" && result.observation.canContinue)
		actions.push("continue", "routeContinue");
	if (screen.kind === "form") {
		actions.push("answer", "section");
		const pageNavigation = result.observation.pageNavigation as {
			canNext: boolean;
			canPrevious: boolean;
		};
		if (pageNavigation.canNext) actions.push("pageNext");
		if (pageNavigation.canPrevious) actions.push("pagePrevious");
		if (result.observation.canSubmit) actions.push("submit");
	}

	return {
		...result,
		observation: {
			...result.observation,
			actions,
			controls: Object.fromEntries(
				actions.flatMap((action) => {
					if (screen.kind === "device-home" && action === "continue")
						return [
							[action, runtimeMessage(context.language, "deviceHomeStart")],
						];
					const label =
						action === "routeBack" || action === "pagePrevious"
							? "back"
							: action === "routeContinue"
								? "continue"
								: action === "pageNext"
									? "next"
									: action;
					return label === "back" ||
						label === "continue" ||
						label === "next" ||
						label === "submit" ||
						label === "search"
						? [[action, runtimeMessage(context.language, label)]]
						: [];
				}),
			),
			platform: {
				selected: result.state.platform,
				label: PLATFORM_LABELS[result.state.platform],
			},
			language: {
				selected: identity,
				direction: languageDirection(identity),
				runtime: runtimeLanguage(context.language),
				available: effectiveAppLocalization(
					context.doc.localization,
				).languageOrder.map(parseLanguageTag),
			},
			route: {
				kind: screen.kind,
				...(screen.kind !== "home" && screen.kind !== "device-home"
					? { moduleUuid: screen.moduleUuid }
					: {}),
				...(screen.kind === "form"
					? { formUuid: screen.formUuid, selectedRecordIds: screen.caseIds }
					: {}),
				...(screen.kind === "details"
					? { selectedRecordId: screen.caseId }
					: {}),
				canGoBack: result.state.history.length > 0,
				ancestorSelections: Object.entries(result.state.selections).map(
					([moduleUuid, selection]) => ({
						moduleUuid,
						caseType: selection.caseType,
						records: selection.cases.map((row) => ({
							id: row.caseId,
							name: row.caseName,
						})),
					}),
				),
			},
		},
	};
}

/**
 * Post the claims CommCare posts at this step, as the browser's Preview does
 * (`lib/preview/searchClaims.ts`): a search action's claim when its result is
 * chosen (`resultSource` names the records screen the choice was made on), and
 * in a menu whose forms read the search, the claim when its case-loading form
 * opens, with the entry's other case datums under a selected parent. Each
 * claim is a claim row the namespace store writes inside the step's
 * transaction (`claimCases`), owned by the session's worker; the session's
 * device snapshot is then read again, as a device restores after a new claim,
 * and a form entered at this step opens over that snapshot. Another session
 * of the same worker sees the claim at its next device read.
 */
async function postAppTestClaims(
	context: AppTestContext,
	scope: AppTestScope,
	before: AppTestSessionState,
	next: AppTestSessionState,
	chosen: readonly PreviewCaseChoice[],
	resultSource?: Extract<AppTestScreen, { kind: "records" }>,
): Promise<{ context: AppTestContext; state: AppTestSessionState }> {
	const sourceModule =
		resultSource === undefined
			? undefined
			: context.doc.modules[resultSource.moduleUuid];
	const atResult =
		resultSource !== undefined &&
		sourceModule !== undefined &&
		next.screen.kind !== "details" &&
		claimPostsAtResult(sourceModule) &&
		recordsReadSearch(sourceModule, resultSource)
			? chosen
			: [];
	const screen = next.screen;
	const atForm =
		screen.kind === "form" && before.screen.kind !== "form"
			? formEntryClaimChoices({
					doc: context.doc,
					moduleUuid: screen.moduleUuid,
					formUuid: screen.formUuid,
					chosen: chosen.filter((choice) =>
						screen.caseIds.includes(choice.caseId),
					),
					selections: next.selections,
				})
			: [];
	const posted = claimableCaseIds([...atResult, ...atForm]);
	if (posted.length === 0) return { context, state: next };
	const { created } = await context.store.claimCases({
		appId: scope.appId,
		caseIds: posted,
	});
	/* Android follows every claim with a sync, so a claim of a case the
	 * worker already claimed still reads its device again there. */
	if (created.length === 0 && !context.rules.claimThenSync)
		return { context, state: next };
	const deviceCases = await context.store.readDeviceCaseDatabase({
		appId: scope.appId,
		restoreScope: context.restoreScope,
	});
	return {
		context,
		state: {
			...next,
			deviceCases,
			screen:
				screen.kind === "form" && screen.entryCases === before.deviceCases
					? { ...screen, entryCases: deviceCases }
					: screen,
		},
	};
}

/** Only actions available on the observed screen can advance this worker. */
export async function advanceAppTest(
	context: AppTestContext,
	scope: Scope,
	state: AppTestSessionState,
	action: AppTestAction,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	let next = state;
	let extra: Observation = {};
	let completedForm: CompletedFormObservation | undefined;
	const screen = state.screen;
	switch (action.kind) {
		case "language":
		case "observe":
			break;
		case "routeBack":
		case "back": {
			const prior = state.history.at(-1);
			if (!prior) throw new AppTestActionError("There is no previous screen.");
			next = {
				...state,
				screen: appTestBackScreen(prior, state.deviceCases),
				history: state.history.slice(0, -1),
			};
			break;
		}
		case "routeContinue":
		case "continue": {
			if (screen.kind === "device-home" && action.kind === "continue") {
				/* Start: the module list, which `StandardHomeActivity::enterRootModule`
				 * opens. */
				next = {
					...state,
					screen: { kind: "home" },
					history: [...state.history, screen],
				};
				break;
			}
			if (
				screen.kind !== "details" ||
				!appTestCanContinue(context, screen.source)
			)
				throw new AppTestActionError(
					"The current screen has no Continue action.",
				);
			const read = await appTestDetails(context, scope, state);
			if (read.result.kind !== "row")
				throw new AppTestActionError("This record is no longer available.");
			if (isCaseListMenuItemList(context, screen.source)) {
				/* The list as it stood before the choice. Android's detail
				 * answers Done there (`EntityDetailActivity.java` in view
				 * mode), which returns to the list with nothing chosen; Web
				 * Apps' Continue takes the entry's route. */
				const last = state.history.at(-1);
				const atList: AppTestSessionState = {
					...state,
					screen: screen.source,
					history:
						last?.kind === "records" &&
						last.moduleUuid === screen.source.moduleUuid
							? state.history.slice(0, -1)
							: state.history,
				};
				next =
					caseListMenuItemDetailAction(context.rules).kind === "return-to-list"
						? atList
						: caseListMenuItemLanding(context, atList);
				break;
			}
			next = selectAppTestRecords(
				context,
				{ ...state, screen: screen.source },
				[read.result.row],
			);
			next = { ...next, history: [...state.history, screen] };
			({ context, state: next } = await postAppTestClaims(
				context,
				scope,
				state,
				next,
				[previewCaseChoiceOf(read.result.row)],
				screen.source,
			));
			break;
		}
		case "home":
			/* Home ends the task, and with it every frame still pending: Android
			 * resets its session at the phone's home screen
			 * (`HomeScreenBaseActivity.java::processCanceledGetCommandOrCase` →
			 * `currentState.reset()`), and Web Apps keeps none. */
			next = {
				...state,
				screen: appTestEntryScreen(state.platform),
				history: [],
				selections: {},
				afterSubmitStack: EMPTY_AFTER_SUBMIT_STACK,
			};
			break;
		case "sync": {
			const deviceCases = await context.store.readDeviceCaseDatabase({
				appId: scope.appId,
				restoreScope: context.restoreScope,
			});
			const rowById = new Map(
				deviceCases.rows.map((row) => [row.case_id, row]),
			);
			const refreshSelection = (
				selection: PreviewMenuCaseSelection,
			): PreviewMenuCaseSelection => ({
				...selection,
				cases: selection.cases.map((choice) => {
					const row = rowById.get(choice.caseId);
					return {
						...choice,
						...(row && { caseName: row.case_name || "Case" }),
						caseProperties: row
							? Object.fromEntries(caseRowToFormPreload(row))
							: {},
					};
				}),
			});
			// A form already entered keeps its captured world. Retained menus and
			// selectors, including a menu reached by Back, use the explicit restore
			// before a new entry instead of overriding it with an older receipt.
			const refreshSelector = <
				T extends Extract<AppTestScreen, { kind: "menu" | "records" }>,
			>(
				task: T,
			): T => ({
				...task,
				...(task.taskCases !== undefined && { taskCases: deviceCases }),
				...(task.kind === "menu" &&
					task.selection !== undefined && {
						selection: refreshSelection(task.selection),
					}),
			});
			const refreshTask = (task: AppTestScreen): AppTestScreen =>
				task.kind === "details"
					? { ...task, source: refreshSelector(task.source) }
					: task.kind === "menu" || task.kind === "records"
						? refreshSelector(task)
						: task;
			next = {
				...state,
				deviceCases,
				screen: refreshTask(screen),
				history: state.history.map(refreshTask),
				selections: Object.fromEntries(
					Object.entries(state.selections).map(([uuid, selected]) => [
						uuid,
						refreshSelection(selected),
					]),
				),
			};
			extra = {
				synced: true,
				availableRecords: next.deviceCases.rows.map((row) => ({
					id: row.case_id,
					type: row.case_type,
				})),
			};
			break;
		}
		case "menu": {
			if (screen.kind !== "home" && screen.kind !== "menu")
				throw new AppTestActionError(
					"Return to a menu before opening another menu.",
				);
			if (
				!appTestMenus(
					context,
					screen.kind === "home" ? null : screen.moduleUuid,
					state,
				).some(
					(menu) =>
						menu.uuid === action.moduleUuid && menu.visibility === "shown",
				)
			)
				throw new AppTestActionError(
					"This menu is not available on the current screen.",
				);
			next = {
				...state,
				screen: enterAppTestMenu(context, state, action.moduleUuid),
				history: [...state.history, screen],
			};
			break;
		}
		case "records": {
			if (screen.kind !== "menu" && screen.kind !== "home")
				throw new AppTestActionError("The current menu has no record list.");
			/* A case list entry the screen lists, the screen's own menu's or
			 * that of a menu showing its forms here; on a menu screen with no
			 * menu named, the menu's own record list. */
			const listed = appTestScreenCaseLists(
				context,
				state,
				screen.kind === "home" ? null : screen.moduleUuid,
			).filter((item) => item.visibility === "shown");
			const named =
				action.moduleUuid ??
				(screen.kind === "menu"
					? screen.moduleUuid
					: listed.length === 1
						? listed[0].moduleUuid
						: undefined);
			if (named === undefined)
				throw new AppTestActionError(
					listed.length === 0
						? "This screen lists no case list."
						: "This screen lists several case lists. Name the menu whose list to open.",
				);
			const listedEntry = listed.find((item) => item.moduleUuid === named);
			if (
				(listedEntry === undefined &&
					!(screen.kind === "menu" && named === screen.moduleUuid)) ||
				!context.doc.modules[named]?.caseType
			)
				throw new AppTestActionError(
					"That case list is not available on the current screen.",
				);
			/* The menu's case list entry: on a forms-first screen it opens the
			 * list, whose choice takes the entry's route; on a case-first screen
			 * the case is already chosen, so choosing the entry is the
			 * selection. */
			const entry = appTestCaseListMenuEntry(context, state, named);
			if (entry?.action === "selection") {
				next = caseListMenuItemLanding(context, state);
				break;
			}
			next = {
				...state,
				screen: {
					kind: "records",
					moduleUuid: named,
					...(entry !== undefined && {
						openedFrom: "case-list-menu-item" as const,
					}),
				},
				history: [...state.history, screen],
			};
			break;
		}
		case "page": {
			if (screen.kind !== "records")
				throw new AppTestActionError(
					"Open a record list before changing pages.",
				);
			next = { ...state, screen: { ...screen, offset: action.offset } };
			break;
		}
		case "form": {
			if (screen.kind === "menu" || screen.kind === "home") {
				/* A form the screen lists, its own menu's or that of a menu
				 * showing its forms here, opens from its own menu. */
				const listed = appTestScreenForms(
					context,
					state,
					screen.kind === "home" ? null : screen.moduleUuid,
				).find((item) => item.form.uuid === action.formUuid);
				if (listed === undefined)
					throw new AppTestActionError(
						"This form is not available on the current menu.",
					);
				next = {
					...state,
					screen: enterAppTestForm(
						context,
						state,
						listed.moduleUuid,
						action.formUuid,
					),
					// The browser's inline chooser is not a route. Back returns
					// to its original Results/Details screen with a fresh read.
					history:
						screen.kind === "menu" && screen.selection
							? state.history
							: [...state.history, screen],
				};
				({ context, state: next } = await postAppTestClaims(
					context,
					scope,
					state,
					next,
					appTestMenuSelection(context, state, listed.moduleUuid)?.cases ?? [],
				));
			} else if (screen.kind === "records") {
				const read = await appTestRecords(context, scope, state);
				const registration = read.registration;
				if (registration?.form.uuid !== action.formUuid)
					throw new AppTestActionError(
						"This form is not offered by the current record list.",
					);
				/* A form offered after an empty search reads that search; a form
				 * the list always offers opens in its own menu, carrying the
				 * launch that decides where it returns. */
				next = {
					...read.state,
					screen:
						registration.arm === "after-empty-search"
							? {
									kind: "form",
									moduleUuid: screen.moduleUuid,
									formUuid: action.formUuid,
									caseIds: [],
									entryCases: state.deviceCases,
									searchAnswers: read.search.submitted,
								}
							: {
									kind: "form",
									moduleUuid: registration.moduleUuid,
									formUuid: action.formUuid,
									caseIds: [],
									entryCases: state.deviceCases,
									caseListRegistrationLaunch: {
										hostModuleUuid: screen.moduleUuid,
									},
								},
					history: [...state.history, read.state.screen],
				};
			} else
				throw new AppTestActionError("Open a menu before choosing a form.");
			break;
		}
		case "select": {
			const read = await appTestRecords(context, scope, state);
			if (
				read.result?.kind !== "rows" ||
				new Set(action.caseIds).size !== action.caseIds.length
			)
				throw new AppTestActionError(
					"Choose distinct records from the visible results.",
				);
			const rows = read.result.grouped
				? read.result.grouped.groups.flatMap((group) => group.rows.slice(0, 1))
				: read.result.rows;
			const selected = action.caseIds.map((id) => {
				const row = rows.find((row) => row.case_id === id);
				if (!row)
					throw new AppTestActionError(
						"A selected record is not on this page of results.",
					);
				return row;
			});
			const recordsScreen = read.state.screen;
			const mod = context.doc.modules[recordsScreen.moduleUuid];
			const multiple = caseSelectionCardinality(mod) !== "single";
			const rowAction = caseSelectionRowAction({
				hasDetails:
					!!mod.caseListConfig &&
					orderedColumns(mod.caseListConfig, "detail").some(
						(column) => column.visibleInDetail !== false,
					),
				multiple,
				canContinue: appTestCanContinue(context, recordsScreen),
			});
			if (!multiple && selected.length !== 1)
				throw new AppTestActionError("Choose one record on this screen.");
			if (!multiple && rowAction === "detail")
				next = {
					...read.state,
					screen: {
						kind: "details",
						moduleUuid: recordsScreen.moduleUuid,
						caseId: selected[0].case_id,
						source: recordsScreen,
					},
					history: [...state.history, read.state.screen],
				};
			else if (isCaseListMenuItemList(context, recordsScreen))
				/* A case list menu entry's list holds no form: the choice takes
				 * the entry's route from the list with nothing chosen. */
				next = caseListMenuItemLanding(context, read.state);
			else
				next = {
					...selectAppTestRecords(context, read.state, selected),
					history: [...state.history, read.state.screen],
				};
			({ context, state: next } = await postAppTestClaims(
				context,
				scope,
				state,
				next,
				selected.map(previewCaseChoiceOf),
				recordsScreen,
			));
			extra = {
				selected: selected.map((row) => ({
					id: row.case_id,
					name: row.case_name,
					values: Object.fromEntries(caseRowToFormPreload(row)),
				})),
			};
			break;
		}
		case "search": {
			const read = await appTestRecords(context, scope, state, action.answers);
			next = read.state;
			extra = { completed: Object.keys(read.search.errors).length === 0 };
			break;
		}
		case "pageNext":
		case "pagePrevious": {
			if (screen.kind !== "form")
				throw new AppTestActionError("Open a form before turning its pages.");
			const held = await appTestFormContext(context, scope, state, screen);
			const evaluated = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
					language: context.language,
					caseIds: screen.caseIds,
					answers: [],
					searchAnswers: screen.searchAnswers,
				},
				held.formContext,
			);
			const pages = availablePages(evaluated.screens);
			const current = pages.findIndex((page) => page.current);
			const target =
				current < 0
					? undefined
					: pages[current + (action.kind === "pageNext" ? 1 : -1)];
			if (!target)
				throw new AppTestActionError(
					"That page turn is not available on this form.",
				);
			const turned = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
					language: context.language,
					caseIds: screen.caseIds,
					answers: [],
					screenPath: target.path,
					searchAnswers: screen.searchAnswers,
				},
				{ ...held.formContext, entry: evaluated.entry },
			);
			const nextScreen: FormScreen = { ...held.screen, entry: turned.entry };
			next = { ...state, screen: nextScreen };
			completedForm = { screen: nextScreen, result: turned };
			/* A forward turn stops on the first earlier screen that fails its
			 * checks, as Next does; the turn completed only when it landed on
			 * the page it was turning to. */
			extra = {
				completed:
					availablePages(turned.screens).find((page) => page.current)?.path ===
					target.path,
			};
			break;
		}
		case "section":
		case "answer": {
			if (screen.kind !== "form")
				throw new AppTestActionError("Open a form before answering questions.");
			const held = await appTestFormContext(context, scope, state, screen);
			const evaluated = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
					language: context.language,
					caseIds: screen.caseIds,
					answers: action.kind === "answer" ? action.answers : [],
					repeats: action.kind === "answer" ? action.repeats : undefined,
					sectionUuid:
						action.kind === "section" ? action.sectionUuid : undefined,
					searchAnswers: screen.searchAnswers,
				},
				held.formContext,
			);
			const nextScreen: FormScreen = { ...held.screen, entry: evaluated.entry };
			next = { ...state, screen: nextScreen };
			completedForm = { screen: nextScreen, result: evaluated };
			if (action.kind === "section")
				extra = {
					/* On Web Apps every section is on the form's one screen, so
					 * each is current. */
					completed: evaluated.sections.some(
						(section) => section.uuid === action.sectionUuid && section.current,
					),
				};
			break;
		}
		case "submit": {
			if (screen.kind !== "form")
				throw new AppTestActionError(
					"Open and answer a form before submitting it.",
				);
			const saved = await submitAppTest(
				context,
				scope,
				state,
				(await appTestFormContext(context, scope, state, screen)).formContext,
			);
			context = { ...context, identity: saved.identity };
			next = saved.state;
			extra = {
				savedInTest: saved.effects !== undefined,
				effects: saved.effects,
				evidence: {
					collectionScope: "disposable-case-store",
					caseTransaction:
						saved.effects === undefined ? "not-committed" : "committed",
					submissionReceipt:
						saved.effects === undefined ? "not-created" : "persisted",
					casePatch:
						(saved.effects?.caseDatabasePatch?.rows.length ?? 0) > 0 ||
						(saved.effects?.caseDatabasePatch?.indices.length ?? 0) > 0
							? "persisted"
							: "none",
					answerDocumentArchive: "not-created",
					serializedSubmission: "not-observed",
					retainedReport: "not-observed",
				},
				validation: saved.validation,
			};
			break;
		}
		case "identity":
			throw new AppTestActionError(
				"Worker switching requires a fresh identity context.",
			);
		case "finish":
			throw new AppTestActionError(
				"Finishing requires disposal of the test namespace.",
			);
	}
	try {
		const observed = await observeAppTestWithEvaluation(
			context,
			scope,
			next,
			completedForm,
		);
		return { ...observed, observation: { ...observed.observation, ...extra } };
	} catch (error) {
		if (
			!expectedAppTestRefusal(error) ||
			extra.savedInTest !== true ||
			screen.kind !== "form"
		)
			throw error;
		const message =
			error instanceof Error
				? error.message
				: "The next task could not be opened.";
		return {
			state: {
				...next,
				screen: {
					kind: "after-submit",
					moduleUuid: screen.moduleUuid,
					message,
				},
			},
			observation: { ...extra, screen: "after-submit", nextTaskError: message },
		};
	}
}

/** A home (`null`) or menu screen's forms, each naming the menu that holds
 *  it, as the screen lists them (`navigation.ts::appTestScreenForms`). */
function screenFormsObservation(
	context: AppTestContext,
	state: AppTestSessionState,
	parent: Uuid | null,
) {
	return appTestScreenForms(context, state, parent).map(
		({ form, moduleUuid, visibility }) => ({
			uuid: form.uuid,
			name: projectLocalizedForm(context.doc, context.language, form.uuid)
				?.name,
			menuUuid: moduleUuid,
			visibility,
		}),
	);
}

/** A home (`null`) or menu screen's case list entries, each naming its menu
 *  and what choosing it opens. */
function screenCaseListsObservation(
	context: AppTestContext,
	state: AppTestSessionState,
	parent: Uuid | null,
) {
	return appTestScreenCaseLists(context, state, parent).map(
		({ moduleUuid, entry, visibility }) => ({
			menuUuid: moduleUuid,
			name:
				context.doc.modules[moduleUuid]?.caseListMenuItem?.label ??
				projectLocalizedModule(context.doc, context.language, moduleUuid)?.name,
			opens:
				entry.action === "selection"
					? ("chosen-case" as const)
					: ("case-list" as const),
			visibility,
		}),
	);
}
