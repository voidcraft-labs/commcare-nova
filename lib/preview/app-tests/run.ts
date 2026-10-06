import type { AppTestScope } from "@/lib/db/appTests";
import {
	assignedLocationUuids,
	caseSelectionCardinality,
	orderedColumns,
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
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { caseListStep } from "../caseListPhase";
import { caseSelectionRowAction } from "../caseSelectionNavigation";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import { evaluateForm } from "../engine/evaluateForm";
import { availablePages } from "../engine/sectionPaging";
import { runtimeLanguage, runtimeMessage } from "../runtimeMessages";
import { projectWorkerModule } from "../workerModule";
import type { AppTestContext } from "./context";
import { appTestCellProjector, appTestDetails } from "./details";
import { AppTestActionError, expectedAppTestRefusal } from "./errors";
import {
	appTestCanContinue,
	appTestForms,
	appTestMenuSelection,
	appTestMenus,
	enterAppTestForm,
	enterAppTestMenu,
	selectAppTestRecords,
} from "./navigation";
import { appTestRecords } from "./records";
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

async function observeScreen(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	const screen = state.screen;
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
					menus: appTestMenus(context, null),
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
					menus: appTestMenus(context, screen.moduleUuid),
					forms: appTestForms(context, state, screen.moduleUuid).map(
						({ form, visibility }) => ({
							uuid: form.uuid,
							name: projectLocalizedForm(
								context.doc,
								context.language,
								form.uuid,
							)?.name,
							visibility,
						}),
					),
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
			const cells = appTestCellProjector(context, screen.moduleUuid, "list");
			return {
				state: read.state,
				observation: {
					screen: caseListStep({
						searchFirst: search.searchFirst,
						hasVisibleInputs: search.hasVisibleInputs,
						hasSubmitted: search.hasSubmitted,
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
						? { uuid: registration.uuid, name: registration.name }
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
					actions:
						read.result.kind === "row" &&
						appTestCanContinue(context, screen.source)
							? ["continue", "back", "home"]
							: ["back", "home"],
				},
			};
		}
		case "form": {
			const evaluated = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
					language: context.language,
					caseIds: screen.caseIds,
					answers: [],
					searchAnswers: screen.searchAnswers,
				},
				{
					identity: context.identity,
					cases: screen.entryCases,
					lookup: context.lookup,
					entry: screen.entry,
					captureEntry: true,
				},
			);
			const pages = availablePages(evaluated.sections);
			const currentPage = pages.findIndex(
				(page) => page.uuid === evaluated.presentation.currentSectionUuid,
			);
			return {
				state: { ...state, screen: { ...screen, entry: evaluated.entry } },
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
	const result = await observeScreen(context, scope, state);
	const screen = result.state.screen;
	const identity = parseLanguageTag(context.language);
	const actions = [
		"observe",
		"identity",
		"language",
		"sync",
		"finish",
		...(screen.kind !== "home" ? ["home"] : []),
		...(result.state.history.length ? ["back", "routeBack"] : []),
	];
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
				...(screen.kind !== "home" ? { moduleUuid: screen.moduleUuid } : {}),
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

/** Only actions available on the observed screen can advance this worker. */
export async function advanceAppTest(
	context: AppTestContext,
	scope: Scope,
	state: AppTestSessionState,
	action: AppTestAction,
): Promise<{ state: AppTestSessionState; observation: Observation }> {
	let next = state;
	let extra: Observation = {};
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
				screen:
					prior.kind === "form"
						? { ...prior, entry: undefined, entryCases: state.deviceCases }
						: prior,
				history: state.history.slice(0, -1),
			};
			break;
		}
		case "routeContinue":
		case "continue": {
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
			next = selectAppTestRecords(
				context,
				{ ...state, screen: screen.source },
				[read.result.row],
			);
			next = { ...next, history: [...state.history, screen] };
			break;
		}
		case "home":
			next = {
				...state,
				screen: { kind: "home" },
				history: [],
				selections: {},
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
			if (
				screen.kind !== "menu" ||
				!context.doc.modules[screen.moduleUuid].caseType
			)
				throw new AppTestActionError("The current menu has no record list.");
			next = {
				...state,
				screen: { kind: "records", moduleUuid: screen.moduleUuid },
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
			if (screen.kind === "menu")
				next = {
					...state,
					screen: enterAppTestForm(
						context,
						state,
						screen.moduleUuid,
						action.formUuid,
					),
					// The browser's inline chooser is not a route. Back returns
					// to its original Results/Details screen with a fresh read.
					history: screen.selection
						? state.history
						: [...state.history, screen],
				};
			else if (screen.kind === "records") {
				const read = await appTestRecords(context, scope, state);
				if (read.registration?.uuid !== action.formUuid)
					throw new AppTestActionError(
						"This form is not offered by the current record list.",
					);
				next = {
					...read.state,
					screen: {
						kind: "form",
						moduleUuid: screen.moduleUuid,
						formUuid: action.formUuid,
						caseIds: [],
						entryCases: state.deviceCases,
						searchAnswers: read.search.submitted,
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
			next =
				!multiple && rowAction === "detail"
					? {
							...read.state,
							screen: {
								kind: "details",
								moduleUuid: recordsScreen.moduleUuid,
								caseId: selected[0].case_id,
								source: recordsScreen,
							},
						}
					: selectAppTestRecords(context, read.state, selected);
			next = { ...next, history: [...state.history, read.state.screen] };
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
			const evaluated = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
					language: context.language,
					caseIds: screen.caseIds,
					answers: [],
					searchAnswers: screen.searchAnswers,
				},
				{
					identity: context.identity,
					cases: screen.entryCases,
					lookup: context.lookup,
					entry: screen.entry,
					captureEntry: true,
				},
			);
			const pages = availablePages(evaluated.sections);
			const current = pages.findIndex(
				(page) => page.uuid === evaluated.presentation.currentSectionUuid,
			);
			const target =
				current < 0
					? undefined
					: pages[current + (action.kind === "pageNext" ? 1 : -1)];
			if (!target)
				throw new AppTestActionError(
					"That page turn is not available on this form.",
				);
			return advanceAppTest(
				context,
				scope,
				{ ...state, screen: { ...screen, entry: evaluated.entry } },
				{ kind: "section", sectionUuid: target.uuid },
			);
		}
		case "section":
		case "answer": {
			if (screen.kind !== "form")
				throw new AppTestActionError("Open a form before answering questions.");
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
				{
					identity: context.identity,
					cases: screen.entryCases,
					lookup: context.lookup,
					entry: screen.entry,
					captureEntry: true,
				},
			);
			next = { ...state, screen: { ...screen, entry: evaluated.entry } };
			if (action.kind === "section")
				extra = {
					completed: evaluated.sections.some(
						(section) => section.uuid === action.sectionUuid && section.current,
					),
				};
			break;
		}
		case "submit": {
			const saved = await submitAppTest(context, scope, state);
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
		const observed = await observeAppTest(context, scope, next);
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
