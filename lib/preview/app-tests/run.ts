import type { AppTestScope } from "@/lib/db/appTests";
import {
	assignedLocationUuids,
	caseSelectionCardinality,
	orderedColumns,
} from "@/lib/domain";
import { caseListStep } from "../caseListPhase";
import { caseSelectionRowAction } from "../caseSelectionNavigation";
import { caseRowToFormPreload } from "../engine/caseDataBindingClient";
import { evaluateForm } from "../engine/evaluateForm";
import type { AppTestContext } from "./context";
import { appTestDetails } from "./details";
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
import type { AppTestAction, AppTestState } from "./types";

type Scope = AppTestScope & {
	role: string;
	blueprintSeq: number;
	blueprintDigest: string;
};
type Observation = Record<string, unknown>;

export async function observeAppTest(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestState,
): Promise<{ state: AppTestState; observation: Observation }> {
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
					name: context.doc.appName,
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
					name: context.doc.modules[screen.moduleUuid].name,
					worker,
					menus: appTestMenus(context, screen.moduleUuid),
					forms: appTestForms(context, state, screen.moduleUuid).map(
						({ form, visibility }) => ({
							uuid: form.uuid,
							name: form.name,
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
			const mod = context.doc.modules[screen.moduleUuid];
			const registration = read.registration;
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
					name: context.doc.modules[screen.moduleUuid].name,
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
			return {
				state: { ...state, screen: { ...screen, entry: evaluated.entry } },
				observation: {
					screen: "form",
					worker,
					name: context.doc.forms[screen.formUuid].name,
					questions: evaluated.fields.filter((field) => field.onCurrentPage),
					sections: evaluated.sections,
					canSubmit: evaluated.canSubmit,
					valid: evaluated.valid,
					submission: "Not submitted",
				},
			};
		}
	}
}

/** Only actions available on the observed screen can advance this worker. */
export async function advanceAppTest(
	context: AppTestContext,
	scope: Scope,
	state: AppTestState,
	action: AppTestAction,
): Promise<{ state: AppTestState; observation: Observation }> {
	let next = state;
	let extra: Observation = {};
	const screen = state.screen;
	switch (action.kind) {
		case "observe":
			break;
		case "back": {
			const prior = state.history.at(-1);
			if (!prior) throw new Error("There is no previous screen.");
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
		case "continue": {
			if (
				screen.kind !== "details" ||
				!appTestCanContinue(context, screen.source)
			)
				throw new Error("The current screen has no Continue action.");
			const read = await appTestDetails(context, scope, state);
			if (read.result.kind !== "row")
				throw new Error("This record is no longer available.");
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
		case "sync":
			next = {
				...state,
				deviceCases: await context.store.readDeviceCaseDatabase({
					appId: scope.appId,
					restoreScope: context.restoreScope,
				}),
			};
			extra = {
				synced: true,
				availableRecords: next.deviceCases.rows.map((row) => ({
					id: row.case_id,
					type: row.case_type,
				})),
			};
			break;
		case "menu": {
			if (screen.kind !== "home" && screen.kind !== "menu")
				throw new Error("Return to a menu before opening another menu.");
			if (
				!appTestMenus(
					context,
					screen.kind === "home" ? null : screen.moduleUuid,
				).some(
					(menu) =>
						menu.uuid === action.moduleUuid && menu.visibility === "shown",
				)
			)
				throw new Error("This menu is not available on the current screen.");
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
				throw new Error("The current menu has no record list.");
			next = {
				...state,
				screen: { kind: "records", moduleUuid: screen.moduleUuid },
				history: [...state.history, screen],
			};
			break;
		}
		case "page": {
			if (screen.kind !== "records")
				throw new Error("Open a record list before changing pages.");
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
					throw new Error(
						"This registration is available only after a search finds no matches.",
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
			} else throw new Error("Open a menu before choosing a form.");
			break;
		}
		case "select": {
			const read = await appTestRecords(context, scope, state);
			if (
				read.result?.kind !== "rows" ||
				new Set(action.caseIds).size !== action.caseIds.length
			)
				throw new Error("Choose distinct records from the visible results.");
			const rows = read.result.grouped
				? read.result.grouped.groups.flatMap((group) => group.rows.slice(0, 1))
				: read.result.rows;
			const selected = action.caseIds.map((id) => {
				const row = rows.find((row) => row.case_id === id);
				if (!row)
					throw new Error("A selected record is not on this page of results.");
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
				throw new Error("Choose one record on this screen.");
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
			break;
		}
		case "section":
		case "answer": {
			if (screen.kind !== "form")
				throw new Error("Open a form before answering questions.");
			const evaluated = await evaluateForm(
				context.doc,
				{
					formUuid: screen.formUuid,
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
			break;
		}
		case "submit": {
			const saved = await submitAppTest(context, scope, state);
			context = { ...context, identity: saved.identity };
			next = saved.state;
			extra = {
				savedInTest: saved.effects !== undefined,
				effects: saved.effects,
				validation: saved.validation,
			};
			break;
		}
		case "identity":
			throw new Error("Worker switching requires a fresh identity context.");
		case "finish":
			throw new Error("Finishing requires disposal of the test namespace.");
	}
	try {
		const observed = await observeAppTest(context, scope, next);
		return { ...observed, observation: { ...observed.observation, ...extra } };
	} catch (error) {
		if (extra.savedInTest !== true || screen.kind !== "form") throw error;
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
