import { CaptureSubmissionRejectedError } from "@/lib/case-store";
import type { AppTestScope } from "@/lib/db/appTests";
import { workerWording } from "@/lib/doc/localizationWorkspace";
import {
	assignedLocationUuids,
	caseSelectionCardinality,
	effectiveCaseSearchConfig,
	orderedColumns,
	orderedOrganizationLevels,
	type Uuid,
} from "@/lib/domain";
import { authoredBoundedFlatSelection } from "@/lib/domain/boundedFlatClose";
import { caseMapSources } from "@/lib/domain/caseMap";
import {
	type GeneratedWordingRole,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
import { languageDirection } from "@/lib/domain/languageRegistry";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import {
	effectiveAppLocalization,
	parseLanguageTag,
} from "@/lib/domain/localization";
import {
	projectLocalizedAppName,
	projectLocalizedForm,
} from "@/lib/domain/localizedBlueprintProjection";
import { PLATFORM_LABELS } from "@/lib/domain/platforms";
import {
	androidAppName,
	missingAndroidApps,
	type RequiredAndroidApp,
} from "@/lib/domain/requiredAndroidApps";
import { locationFixtureRows } from "@/lib/organization/footprint";
import type {
	PreviewCaseChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { EMPTY_AFTER_SUBMIT_STACK } from "../afterSubmitStack";
import { caseListMenuItemDetailAction } from "../caseListMenuItemRoute";
import { caseListStep } from "../caseListPhase";
import { caseListActionChoices } from "../caseListRegistration";
import { caseMapRows, workerMapOffered } from "../caseMap";
import { caseSelectionRowAction } from "../caseSelectionNavigation";
import { deviceHomeButtons } from "../deviceHome";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import { evaluateForm } from "../engine/evaluateForm";
import { appReadsPlaces } from "../engine/expressionCaseReads";
import { searchInputInstanceValues } from "../engine/runtimeBindings";
import {
	SearchChoiceUnavailable,
	searchClaimMemberships,
} from "../engine/searchClaimSelection";
import { drawnSearchInputs } from "../engine/searchRunState";
import { availablePages } from "../engine/sectionPaging";
import {
	recordsReadSearch,
	searchedReading,
	serverSearchResults,
} from "../engine/serverSearchRead";
import {
	type CaseDatabaseSnapshot,
	type CompletedFormSearch,
	formReadsSearchScore,
	formSearchReads,
} from "../engine/xpathInstances";
import { runtimeLanguage, runtimeMessage } from "../runtimeMessages";
import {
	claimableCaseIds,
	claimPostsAtResult,
	formEntryClaimChoices,
	previewCaseChoiceOf,
} from "../searchClaims";
import { searchAfterClear } from "../searchStanding";
import { projectWorkerModule } from "../workerModule";
import { type AppTestContext, readAppTestDeviceCaseDatabase } from "./context";
import {
	appTestDataRefusal,
	appTestRefusalSentence,
	readingSurface,
} from "./dataRefusal";
import {
	appTestCellProjector,
	appTestDetails,
	appTestFormCaseContext,
} from "./details";
import { AppTestActionError, expectedAppTestRefusal } from "./errors";
import {
	appTestCanContinue,
	appTestCaseListMenuEntry,
	appTestCaseListScreen,
	appTestEntryScreen,
	appTestHistoryEntry,
	appTestMenuSelection,
	appTestMenus,
	appTestRecordsHaveDetails,
	appTestScreenCaseLists,
	appTestScreenForms,
	appTestStepBack,
	caseListMenuItemLanding,
	enterAppTestForm,
	enterAppTestMenu,
	isCaseListMenuItemList,
	selectAppTestRecords,
} from "./navigation";
import {
	appTestRecords,
	appTestSearchWorld,
	prepareAppTestRecords,
} from "./records";
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

function controlText(
	context: AppTestContext,
	owner: string,
	role: GeneratedWordingRole,
	overrideOnly = false,
) {
	return workerWording(
		context.doc,
		context.language,
		generatedWordingId(owner, role),
		overrideOnly,
	);
}

/** The entry's device world: its cases and, for an app whose forms read
 * places, the worker's `locations` fixture, which the session's restore
 * delivers beside them (as Preview's snapshot carries it). */
function appTestEntryCases(
	context: AppTestContext,
	state: AppTestSessionState,
	cases: CaseDatabaseSnapshot,
): CaseDatabaseSnapshot {
	const workerGroups = context.workerGroups;
	if (!appReadsPlaces(context.doc)) return { ...cases, workerGroups };
	const persona =
		state.personaUuid === null
			? undefined
			: context.doc.personas?.[state.personaUuid];
	return {
		...cases,
		workerGroups,
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
async function appTestCompletedSearch(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	supplier: Uuid,
	needsResults: boolean,
	needsScore: boolean,
): Promise<CompletedFormSearch> {
	const refused = () =>
		new AppTestActionError(
			`${runtimeMessage(context.language, "searchResultsRefusalTitle")}. ${runtimeMessage(context.language, "searchResultsRefusalBody")}`,
		);
	for (let index = state.history.length - 1; index >= 0; index--) {
		const prior = state.history[index];
		if (prior.kind === "form" || prior.kind === "home") break;
		if (prior.kind !== "records" || prior.moduleUuid !== supplier) continue;
		if (
			prior.searchAnswers === undefined &&
			prior.registeredCaseId === undefined
		)
			throw refused();
		const { read, refusal } = await prepareAppTestRecords(context, scope, {
			...state,
			selections: prior.shownWith,
			screen: prior,
		});
		if (refusal !== undefined) throw new AppTestActionError(refusal);
		const results = needsResults
			? await readingSurface("search", () =>
					serverSearchResults(context.store, read, needsScore),
				)
			: undefined;
		if (needsResults && !results) throw refused();
		const answers = searchInputInstanceValues(
			context.doc.modules[supplier].caseListConfig?.searchInputs ?? [],
			new Map(
				(prior.searchAnswers ?? []).map(({ name, value }) => [name, value]),
			),
		);
		return {
			menu: supplier,
			submission: `${supplier}/${index}`,
			answers: [...answers],
			...(results && { results }),
		};
	}
	throw refused();
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
async function readAppTestFlatClose(
	context: AppTestContext,
	scope: AppTestScope,
	caseType: string,
	caseIds: readonly string[],
	automaticMaximum?: number,
) {
	try {
		const cases = await context.store.readFlatCloseSelection({
			appId: scope.appId,
			restoreScope: context.restoreScope,
			caseType,
			caseIds,
			automaticMaximum,
		});
		if (!cases)
			throw new AppTestActionError(
				"The selected records are no longer available.",
			);
		return cases;
	} catch (error) {
		if (error instanceof CaptureSubmissionRejectedError)
			throw new AppTestActionError(error.message);
		throw error;
	}
}

async function appTestFormContext(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	screen: FormScreen,
) {
	const flatClose = authoredBoundedFlatSelection(
		context.doc,
		screen.moduleUuid,
		screen.formUuid,
	);
	if (flatClose && !screen.entry) {
		const selected = await readAppTestFlatClose(
			context,
			scope,
			flatClose.caseType,
			screen.caseIds,
			flatClose.selection.autoSelect ? flatClose.selection.maximum : undefined,
		);
		screen = { ...screen, entryCases: selected };
	}
	let searches = screen.searches;
	let searchResults = screen.searchResults;
	if (searches === undefined) {
		const frames: CompletedFormSearch[] = [];
		for (const [supplier, read] of formSearchReads(
			context.doc,
			screen.formUuid,
			screen.moduleUuid,
		)) {
			if (supplier === screen.moduleUuid) {
				if (read.readsResults && !searchResults)
					searchResults = (
						await appTestCompletedSearch(
							context,
							scope,
							state,
							supplier,
							true,
							formReadsSearchScore(context.doc, screen.formUuid),
						)
					).results;
			} else {
				frames.push(
					await appTestCompletedSearch(
						context,
						scope,
						state,
						supplier,
						read.readsResults,
						formReadsSearchScore(context.doc, screen.formUuid),
					),
				);
			}
		}
		searches = frames;
	}

	return {
		screen:
			searches.length || searchResults !== undefined
				? { ...screen, searches, searchResults }
				: screen,
		formContext: {
			identity: context.identity,
			device: context.device,
			cases: appTestEntryCases(context, state, screen.entryCases),
			lookup: context.lookup,
			entry: screen.entry,
			captureEntry: true,
			session: {
				appId: scope.appId,
				menuSelections:
					screen.caseListRegistrationLaunch?.selections ?? state.selections,
				entryChoices: screen.entryChoices,
				heldEntryValues: screen.heldEntryValues,
			},
			searches,
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
					name: controlText(context, screen.moduleUuid, "menuTitle"),
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
					/* The module's case list menu entry, listed after the forms
					 * while it still needs a case the screen has not chosen; the
					 * `records` action chooses it and opens its case list. */
					caseListEntry: (() => {
						const entry = appTestCaseListMenuEntry(
							context,
							state,
							screen.moduleUuid,
						);
						return entry === undefined
							? undefined
							: {
									name: controlText(
										context,
										screen.moduleUuid,
										"caseListEntry",
									),
								};
					})(),
					recordsAvailable:
						menuWithInheritedCaseSettings(context.doc, screen.moduleUuid)
							?.caseType !== undefined,
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
						searchReopened: read.state.screen.searchEntry?.cleared === true,
						hasSubmitted: search.hasSubmitted,
						submittedFoundNothing: read.result?.kind === "empty",
						rules: context.rules,
					}),
					worker,
					name: mod.name,
					/* A list that opens first whose Search screen refused data the
					 * device lacks as it opened shows the refusal in its Search
					 * pane, as Preview does, and offers no Search. */
					search: !search.relevant
						? undefined
						: search.paneRefusal !== undefined
							? {
									refusal: appTestRefusalSentence(
										context,
										"search",
										search.paneRefusal,
									),
								}
							: {
									/* The fields the platform's Search screen draws:
									 * Web Apps draws no field marked hidden. */
									questions: drawnSearchInputs(
										mod.caseListConfig?.searchInputs ?? [],
										context.rules,
									)
										.filter((input) => input.kind !== "hidden")
										.map((input) => ({
											name: input.name,
											label: input.label,
											type: input.type,
											hint: input.hint,
										})),
									answers: search.displayedAnswers,
									errors: search.errors,
								},
					results: read.result,
					renderedResults:
						read.result?.kind === "rows"
							? {
									...(mod.caseListConfig &&
										workerMapOffered(
											state.platform,
											caseMapSources(mod.caseListConfig, "list").locations
												.length > 0,
											read.result.rows.length > 0,
											null,
										) && {
											availableMap: caseMapRows(
												state.platform,
												mod.caseListConfig,
												read.result.rows,
												searchedReading(read.searched).columns,
											).map(({ row, geometry }) => ({
												recordId: row.case_id,
												...geometry,
											})),
										}),
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
						? {
								uuid: registration.form.uuid,
								name:
									controlText(context, screen.moduleUuid, "registerButton") ??
									registration.form.name,
							}
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
					name: controlText(context, screen.moduleUuid, "menuTitle"),
					record: read.result.kind === "row" ? read.result.row : undefined,
					unavailable: read.result.kind !== "row",
					fields: read.fields,
					...(read.tabs && { tabs: read.tabs }),
					canContinue:
						read.result.kind === "row" &&
						appTestCanContinue(context, screen.source),
					/* What `continue` presses here: Android's Done on a case list
					 * menu entry's detail, which returns to the list. The list's
					 * own Continue wording labels only Web Apps' several-case
					 * Continue (`multi_select_continue_button.html`), never a
					 * single case's detail. */
					continueLabel: runtimeMessage(
						context.language,
						isCaseListMenuItemList(context, screen.source)
							? caseListMenuItemDetailAction(context.rules).message
							: "continue",
					),
					title:
						controlText(context, "app", "caseTitle", true) ??
						((read.result.kind === "row" && read.result.row.case_name) ||
							runtimeMessage(context.language, "case")),
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
			const caseContext = await appTestFormCaseContext(context, scope, state);
			return {
				state: {
					...state,
					screen: { ...renderedScreen, entry: evaluated.entry },
				},
				observation: {
					screen: "form",
					...(caseContext && { caseContext }),
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
	try {
		return await observeAppTestWithEvaluation(context, scope, state);
	} catch (error) {
		throw appTestDataRefusal(context, error);
	}
}

function requiredAppName(
	context: AppTestContext,
	app: RequiredAndroidApp,
): string {
	const code = effectiveAppLocalization(context.doc.localization).wireCodes[
		context.language
	];
	return androidAppName(app, code, context.androidAppLabels);
}

async function observeAppTestWithEvaluation(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	completedForm?: CompletedFormObservation,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	const missing = missingAndroidApps(
		state.platform,
		context.doc.appSettings.requiredAndroidApps,
		state.installedAndroidApps,
	);
	if (state.awaitingAndroidApps && missing.length > 0) {
		return {
			state,
			observation: {
				screen: "required-android-apps",
				missingApps: missing.map((app) => ({
					app,
					name: requiredAppName(context, app),
				})),
				actions: ["observe", "back", "finish"],
				platform: {
					selected: state.platform,
					label: PLATFORM_LABELS[state.platform],
				},
				recovery:
					"Start a test with the required apps in installedAndroidApps to try opening the app on this phone.",
			},
		};
	}
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
		const search = result.observation.search as
			| { readonly refusal?: string }
			| undefined;
		if (search !== undefined && search.refusal === undefined)
			actions.push("search");
		if (
			result.observation.screen === "results" ||
			result.observation.screen === "browse"
		)
			actions.push("select", "page");
		if (result.observation.registration) actions.push("form");
	}
	if (
		screen.kind === "details" &&
		Array.isArray(result.observation.tabs) &&
		result.observation.tabs.length > 1
	)
		actions.push("detailTab");
	if (screen.kind === "details" && result.observation.canContinue)
		actions.push("continue", "routeContinue");
	if (screen.kind === "form") {
		actions.push("answer", "section");
		if (
			(result.observation.caseContext as { expandable?: boolean } | undefined)
				?.expandable
		)
			actions.push("caseContext");
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
					if (screen.kind === "form" && action === "submit") {
						return [
							[
								action,
								(context.rules.submitLabel === "submit"
									? controlText(context, screen.formUuid, "submitButton", true)
									: undefined) ??
									runtimeMessage(context.language, context.rules.submitLabel),
							],
						];
					}
					if (
						screen.kind === "details" &&
						(action === "continue" || action === "routeContinue")
					) {
						const label = result.observation.continueLabel;
						return [
							[
								action,
								typeof label === "string"
									? label
									: runtimeMessage(context.language, "continue"),
							],
						];
					}
					if (screen.kind === "records" && action === "search")
						return [
							[
								action,
								controlText(context, screen.moduleUuid, "searchButton") ??
									runtimeMessage(context.language, "search"),
							],
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
				direction: languageDirection(identity, context.doc.localization),
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
	const visited = [...before.history, ...next.history].reverse();
	const sourceFrame = (moduleUuid: Uuid) =>
		resultSource?.moduleUuid === moduleUuid
			? resultSource
			: visited.find(
					(frame): frame is Extract<typeof frame, { kind: "records" }> =>
						frame.kind === "records" &&
						frame.moduleUuid === moduleUuid &&
						frame.searchAnswers !== undefined,
				);
	const bySource = new Map<
		Uuid,
		{ caseIds: string[]; answers: { name: string; value: string }[] }
	>();
	for (const choice of [...atResult, ...atForm]) {
		if (!choice.claimable) continue;
		// Earlier retained sessions may still carry a choice made before
		// selections held their search. Its original records screen is durable.
		const menu =
			choice.searchSource?.moduleUuid ??
			(atResult.includes(choice) ? resultSource?.moduleUuid : undefined) ??
			Object.values(context.doc.modules).find((mod) =>
				next.selections[mod.uuid]?.cases.some(
					(row) => row.caseId === choice.caseId,
				),
			)?.uuid ??
			(screen.kind === "form" ? screen.moduleUuid : undefined);
		const answers =
			menu &&
			(choice.searchSource?.answers ?? sourceFrame(menu)?.searchAnswers);
		if (!menu || !answers)
			throw new AppTestActionError(new SearchChoiceUnavailable().message);
		const group = bySource.get(menu) ?? { caseIds: [], answers: [...answers] };
		if (!group.caseIds.includes(choice.caseId))
			group.caseIds.push(choice.caseId);
		bySource.set(menu, group);
	}
	const memberships = [];
	for (const [moduleUuid, source] of bySource) {
		const frame = sourceFrame(moduleUuid);
		const selections =
			frame && "shownWith" in frame
				? (frame.shownWith as AppTestSessionState["selections"])
				: before.selections;
		const prior = Object.entries(selections).flatMap(([id, selection]) => {
			const menu = context.doc.modules[id];
			if (!menu || !selection.cases.length) return [];
			const answers =
				selection.cases[0].searchSource?.answers ??
				(selection.cases.some((choice) => choice.claimable)
					? sourceFrame(menu.uuid)?.searchAnswers
					: undefined);
			return [
				{
					moduleUuid: menu.uuid,
					caseIds: selection.cases.map((row) => row.caseId),
					...(answers && { answers: [...answers] }),
				},
			];
		});
		try {
			memberships.push(
				...(await searchClaimMemberships(
					appTestSearchWorld(context, scope, before),
					[{ moduleUuid, ...source }],
					prior,
				)),
			);
		} catch (error) {
			if (error instanceof SearchChoiceUnavailable)
				throw new AppTestActionError(error.message);
			throw error;
		}
	}
	const { created } = await context.store.claimCases({
		appId: scope.appId,
		caseIds: posted,
		fromSearches: memberships,
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

/** Only actions available on the observed screen can advance this worker. A
 *  screen a phone stops on, because a menu reads data the device lacks, is the
 *  worker's refusal, in the words Preview shows it in. */
/** Follow only automatic choices after a fresh navigation step. Back returns
 * the saved user-input boundary without selecting its single row again. */
async function advanceAutomaticChoices(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
): Promise<AppTestSessionState> {
	let cursor = state;
	while (cursor.screen.kind === "records") {
		const screen = cursor.screen;
		const selection = menuWithInheritedCaseSettings(
			context.doc,
			screen.moduleUuid,
		)?.caseListConfig?.selection;
		if (
			!screen.formEntry &&
			selection?.autoSelect &&
			appTestCanContinue(context, screen)
		) {
			const read = await appTestRecords(
				context,
				scope,
				cursor,
				undefined,
				selection.maximum,
			);
			if (read.result?.kind !== "rows") return read.state;
			const count = Math.max(
				read.result.totalCount ?? 0,
				read.result.rows.length,
			);
			if (count > selection.maximum)
				throw new AppTestActionError(
					runtimeMessage(context.language, "automaticSelectionTooMany", {
						count,
						maximum: selection.maximum,
					}),
				);
			if (isCaseListMenuItemList(context, read.state.screen))
				return caseListMenuItemLanding(context, read.state);
			const next = selectAppTestRecords(context, read.state, read.result.rows);
			({ context, state: cursor } = await postAppTestClaims(
				context,
				scope,
				cursor,
				next,
				read.result.rows.map(previewCaseChoiceOf),
				read.state.screen,
			));
			continue;
		}
		if (!screen.formEntry?.next.autoSelectSingle) return cursor;
		const read = await appTestRecords(context, scope, cursor);
		if (
			read.result?.kind !== "rows" ||
			read.result.totalCount !== 1 ||
			read.result.rows.length !== 1
		)
			return read.state;
		const [row] = read.result.rows;
		if (screen.formEntry.next.confirms)
			return {
				...read.state,
				screen: {
					kind: "details",
					moduleUuid: cursor.screen.moduleUuid,
					caseId: row.case_id,
					source: read.state.screen,
				},
			};
		cursor = selectAppTestRecords(context, read.state, [row]);
	}
	return cursor;
}

export async function advanceAppTest(
	context: AppTestContext,
	scope: Scope,
	state: AppTestSessionState,
	action: AppTestAction,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	try {
		const missing = missingAndroidApps(
			state.platform,
			context.doc.appSettings.requiredAndroidApps,
			state.installedAndroidApps,
		);
		if (
			missing.length &&
			!state.awaitingAndroidApps &&
			state.screen.kind === "device-home" &&
			action.kind === "continue"
		) {
			return await observeAppTest(context, scope, {
				...state,
				awaitingAndroidApps: true,
			});
		}
		if (state.awaitingAndroidApps && missing.length) {
			if (action.kind === "back")
				return await observeAppTest(context, scope, {
					...state,
					awaitingAndroidApps: false,
				});
			if (action.kind !== "observe")
				throw new AppTestActionError(
					`This Android phone needs ${missing.map((app) => requiredAppName(context, app)).join(", ")} before the worker can open the app.`,
				);
		}
		return await advanceAppTestOnScreen(context, scope, state, action);
	} catch (error) {
		throw appTestDataRefusal(context, error);
	}
}

async function advanceAppTestOnScreen(
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
		case "caseContext": {
			if (screen.kind !== "form")
				throw new AppTestActionError("Open a form with case context first.");
			const candidate = {
				...state,
				screen: {
					...screen,
					contextExpanded: action.expanded ? (true as const) : undefined,
					contextTabUuid: action.tabUuid,
				},
			};
			const contextView = await appTestFormCaseContext(
				context,
				scope,
				candidate,
			);
			if (
				!contextView?.expandable ||
				(action.tabUuid &&
					(!action.expanded ||
						!("details" in contextView) ||
						!contextView.details?.tabs?.some(
							(tab) => tab.uuid === action.tabUuid,
						)))
			)
				throw new AppTestActionError(
					"This form has no matching expandable case detail.",
				);
			next = candidate;
			break;
		}
		case "detailTab": {
			if (screen.kind !== "details")
				throw new AppTestActionError(
					"Open case details before choosing a tab.",
				);
			const read = await appTestDetails(context, scope, state);
			if (!read.tabs?.some((tab) => tab.uuid === action.tabUuid))
				throw new AppTestActionError(
					"This tab is unavailable for the selected case.",
				);
			next = { ...state, screen: { ...screen, tabUuid: action.tabUuid } };
			break;
		}
		case "routeBack":
		case "back": {
			next = appTestStepBack(state);
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
					history: [
						...state.history,
						appTestHistoryEntry(screen, state.selections),
					],
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
			next = {
				...next,
				history: [
					...state.history,
					appTestHistoryEntry(screen, state.selections),
				],
			};
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
			const deviceCases = await readAppTestDeviceCaseDatabase(
				context,
				scope.appId,
			);
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
			const refreshSelections = (
				selections: AppTestSessionState["selections"],
			): AppTestSessionState["selections"] =>
				Object.fromEntries(
					Object.entries(selections).map(([uuid, selected]) => [
						uuid,
						refreshSelection(selected),
					]),
				);
			// A screen Back returns to holds the selections it was shown with,
			// whose records read as the device now holds them.
			next = {
				...state,
				deviceCases,
				screen: refreshTask(screen),
				history: state.history.map((entry) =>
					appTestHistoryEntry(
						refreshTask(entry),
						refreshSelections(entry.shownWith),
					),
				),
				selections: refreshSelections(state.selections),
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
				history: [
					...state.history,
					appTestHistoryEntry(screen, state.selections),
				],
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
				!menuWithInheritedCaseSettings(context.doc, named)?.caseType
			)
				throw new AppTestActionError(
					"That case list is not available on the current screen.",
				);
			/* The menu's case list entry, where the screen lists it, opens its
			 * list, whose choice takes the entry's route. A list that asks for
			 * its parent case asks for it first, then opens. */
			const entry = appTestCaseListMenuEntry(context, state, named);
			next = {
				...state,
				screen: appTestCaseListScreen(context, state, {
					kind: "records",
					moduleUuid: named,
					...(entry !== undefined && {
						openedFrom: "case-list-menu-item" as const,
					}),
				}),
				history: [
					...state.history,
					appTestHistoryEntry(screen, state.selections),
				],
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
							: [
									...state.history,
									appTestHistoryEntry(screen, state.selections),
								],
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
				const supplied = caseListActionChoices(
					context.doc,
					screen.moduleUuid,
					action.formUuid,
					state.selections,
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
									caseListRegistrationLaunch: {
										hostModuleUuid: screen.moduleUuid,
									},
								}
							: {
									kind: "form",
									moduleUuid: registration.moduleUuid,
									formUuid: action.formUuid,
									caseIds: (supplied[registration.moduleUuid]?.cases ?? []).map(
										(choice) => choice.caseId,
									),
									entryCases: state.deviceCases,
									caseListRegistrationLaunch: {
										hostModuleUuid: screen.moduleUuid,
										selections: supplied,
									},
								},
					history: [
						...state.history,
						appTestHistoryEntry(read.state.screen, state.selections),
					],
				};
			} else
				throw new AppTestActionError("Open a menu before choosing a form.");
			break;
		}
		case "select": {
			if (screen.kind === "records" && !screen.formEntry) {
				const flatClose = authoredBoundedFlatSelection(
					context.doc,
					screen.moduleUuid,
					context.doc.formOrder[screen.moduleUuid]?.[0],
				);
				if (flatClose?.selection.autoSelect)
					throw new AppTestActionError(
						"This list chooses eligible records automatically.",
					);
				if (flatClose) {
					const selected = await readAppTestFlatClose(
						context,
						scope,
						flatClose.caseType,
						action.caseIds,
					);
					const rows = new Map(selected.rows.map((row) => [row.case_id, row]));
					const ordered = action.caseIds.map((id) => {
						const row = rows.get(id);
						if (!row) throw new Error("An admitted flat-close row is missing.");
						return { ...row, calculated: {} };
					});
					next = {
						...selectAppTestRecords(context, state, ordered),
						history: [
							...state.history,
							appTestHistoryEntry(screen, state.selections),
						],
					};
					extra = {
						selected: ordered.map((row) => ({
							id: row.case_id,
							name: row.case_name,
							values: Object.fromEntries(caseRowToFormPreload(row)),
						})),
					};
					break;
				}
			}
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
			if (!recordsScreen.formEntry && mod.caseListConfig?.selection?.autoSelect)
				throw new AppTestActionError(
					"This list chooses eligible records automatically.",
				);
			const multiple =
				!recordsScreen.formEntry && caseSelectionCardinality(mod) !== "single";
			const rowAction = caseSelectionRowAction({
				hasDetails: appTestRecordsHaveDetails(
					context,
					recordsScreen,
					!!mod.caseListConfig &&
						orderedColumns(mod.caseListConfig, "detail").some(
							(column) => column.visibleInDetail !== false,
						),
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
					history: [
						...state.history,
						appTestHistoryEntry(read.state.screen, state.selections),
					],
				};
			else if (isCaseListMenuItemList(context, recordsScreen))
				/* A case list menu entry's list holds no form: the choice takes
				 * the entry's route from the list with nothing chosen. */
				next = caseListMenuItemLanding(context, read.state);
			else
				next = {
					...selectAppTestRecords(context, read.state, selected),
					history: [
						...state.history,
						appTestHistoryEntry(read.state.screen, state.selections),
					],
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
		case "clearSearch": {
			if (screen.kind !== "records" || !context.rules.searchClear)
				throw new AppTestActionError("This screen has no Clear button.");
			const current = await prepareAppTestRecords(context, scope, state);
			if (
				!current.search.relevant ||
				(!current.search.hasSubmitted && current.search.draft.length === 0)
			)
				throw new AppTestActionError("This screen has no search to clear.");
			const module = context.doc.modules[screen.moduleUuid];
			const alsoSearch =
				module !== undefined &&
				searchAfterClear(
					effectiveCaseSearchConfig(module)?.searchOnClear === true &&
						module.caseListConfig?.selection?.autoSelect !== true,
					context.rules,
					context.device.windowWidth,
				);
			const cleared = {
				...state,
				screen: {
					...screen,
					searchEntry: { cleared: true as const, draft: [], errors: {} },
					searchAnswers: undefined,
					registeredCaseId: undefined,
					offset: 0,
				},
			};
			const read = await appTestRecords(
				context,
				scope,
				cleared,
				alsoSearch ? [] : undefined,
			);
			/* The search Web Apps runs after Clear is quiet: a blank required
			 * field stops it without an error (`query.js::updateSearchResults`),
			 * so the cleared screen shows none. */
			next =
				read.state.screen.kind === "records" &&
				read.state.screen.searchAnswers === undefined
					? {
							...read.state,
							screen: {
								...read.state.screen,
								searchEntry: {
									cleared: true as const,
									draft: read.state.screen.searchEntry?.draft ?? [],
									errors: {},
								},
							},
						}
					: read.state;
			extra = { completed: true };
			break;
		}
		case "search": {
			const read = await appTestRecords(context, scope, state, action.answers);
			next = read.state;
			extra = {
				completed:
					read.result?.kind === "rows" || read.result?.kind === "empty",
			};
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
			const { formContext } = await appTestFormContext(
				context,
				scope,
				state,
				screen,
			);
			const saved = await readingSurface("form", () =>
				submitAppTest(context, scope, state, formContext),
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
		if (action.kind !== "back" && next.screen !== state.screen) {
			next = await advanceAutomaticChoices(context, scope, next);
		}
		const observed = await observeAppTestWithEvaluation(
			context,
			scope,
			next,
			completedForm,
		);
		return { ...observed, observation: { ...observed.observation, ...extra } };
	} catch (error) {
		/* The form is saved, so the next screen's refusal of data the device
		 * lacks keeps it, as Preview shows the refusal after the save. */
		const refused = appTestDataRefusal(context, error);
		if (
			!expectedAppTestRefusal(refused) ||
			extra.savedInTest !== true ||
			screen.kind !== "form"
		)
			throw error;
		const message = refused.message;
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
		({ form, moduleUuid, visibility, badge }) => ({
			...(badge && { badge }),
			uuid: form.uuid,
			name: controlText(context, form.uuid, "formTitle"),
			menuUuid: moduleUuid,
			visibility,
		}),
	);
}

/** A home (`null`) or menu screen's case list entries, each naming its
 *  menu; choosing one opens that menu's case list. */
function screenCaseListsObservation(
	context: AppTestContext,
	state: AppTestSessionState,
	parent: Uuid | null,
) {
	return appTestScreenCaseLists(context, state, parent).map(
		({ moduleUuid, visibility }) => ({
			menuUuid: moduleUuid,
			name: controlText(context, moduleUuid, "caseListEntry"),
			visibility,
		}),
	);
}
