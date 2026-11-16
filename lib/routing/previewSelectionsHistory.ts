/**
 * The case selections a Preview history entry was shown with, so that Back
 * past Home shows the entry's screen as Web Apps shows a popped address.
 *
 * Web Apps keeps the session's steps on the page's address: every address is
 * a `CloudcareUrl` whose `selections` are the menus and cases chosen to reach
 * it (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl`, `addSelection`).
 * Home clears them from the address it writes (`clearExceptApp`,
 * `spliceSelections(0)`), never from an address already in the browser's
 * history. Back onto such an address routes it again
 * (`formplayer/router.js::listMenus` → `menus/controller.js::selectMenu`),
 * which asks Formplayer for `navigate_menu` with that address's selections,
 * and Formplayer replays every one of them into a new session
 * (`MenuController.navigateSessionWithAuth` →
 * `MenuSessionRunnerService.advanceSessionWithSelections` →
 * `MenuSession.handleInput`), so the popped screen shows with the cases its
 * address holds.
 *
 * Preview keeps those cases in the session store, which Home clears
 * (`lib/session/store.ts::clearPreviewNavigation`), and every Home starts a
 * new task (`previewTaskId`). So each entry records, beside its address, the
 * cases the store held while it was shown, with the Preview session and the
 * task it was shown in. An arrival in the same session and another task (Back
 * or Forward past Home) puts them back before any screen reads them, taking
 * that task up again. Within one task the session can have moved on from what
 * an entry shows (a crumb let a case go, a later list chose another), and Web
 * Apps replays the popped address's selections there too, so an arrival puts
 * the entry's selections back wherever they differ from the session's.
 *
 * Android has no address: Preview's browser history stands for nothing a
 * phone keeps, and its Back is the device's step back
 * (`CommCareSession.stepBack`, modelled on the screens), so on Android the
 * session as it stands is what an entry shows (`rules.poppedEntrySelections`).
 */
import type { Uuid } from "@/lib/doc/types";
import type {
	PreviewCaseChoice,
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewSelectedCase,
} from "@/lib/session/types";

export const PREVIEW_SELECTIONS_STATE_KEY = "__novaPreviewSelections";

/** The part of a form's case target that is the session's selections: the
 *  form and the cases chosen for it, and how they were chosen. What a target
 *  carries beyond that (a Register launch, a link's device world) belongs to
 *  the one entry of the form that launch opened, never to an address. */
export type PreviewSelectionsTarget = Pick<
	PreviewCaseTarget,
	"formUuid" | "cases" | "caseListSearchText" | "formChosenAfterCase"
>;

/** The session's case selections, as the store holds them. */
export interface PreviewSessionSelections {
	readonly menu: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly target: PreviewSelectionsTarget | undefined;
	readonly selected: PreviewSelectedCase | undefined;
}

/** What an entry records: the selections it was shown with, in which
 *  Preview session and which task of it. */
export interface RecordedPreviewSelections extends PreviewSessionSelections {
	readonly session: string;
	readonly task: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function caseChoiceOf(
	value: unknown,
):
	| (PreviewCaseChoice & { caseProperties?: Record<string, string> })
	| undefined {
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const { caseId, caseName, claimable, caseProperties } = record;
	if (typeof caseId !== "string") return undefined;
	if (caseName !== undefined && typeof caseName !== "string") return undefined;
	if (claimable !== undefined && claimable !== true) return undefined;
	const properties = recordOf(caseProperties);
	if (caseProperties !== undefined) {
		if (
			properties === undefined ||
			Object.values(properties).some((v) => typeof v !== "string")
		)
			return undefined;
	}
	return {
		caseId,
		...(caseName !== undefined && { caseName }),
		...(claimable === true && { claimable }),
		...(properties !== undefined && {
			caseProperties: { ...(properties as Record<string, string>) },
		}),
	};
}

function caseChoicesOf(
	value: unknown,
): NonNullable<ReturnType<typeof caseChoiceOf>>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const choices: NonNullable<ReturnType<typeof caseChoiceOf>>[] = [];
	for (const item of value) {
		const choice = caseChoiceOf(item);
		if (choice === undefined) return undefined;
		choices.push(choice);
	}
	return choices;
}

function menuOf(
	value: unknown,
): Record<string, PreviewMenuCaseSelection> | undefined {
	const record = recordOf(value);
	if (record === undefined) return undefined;
	const menu: Record<string, PreviewMenuCaseSelection> = {};
	for (const [moduleUuid, selection] of Object.entries(record)) {
		const fields = recordOf(selection);
		const cases = caseChoicesOf(fields?.cases);
		if (typeof fields?.caseType !== "string" || cases === undefined)
			return undefined;
		menu[moduleUuid] = {
			caseType: fields.caseType,
			cases: cases as PreviewMenuCaseSelection["cases"],
		};
	}
	return menu;
}

function targetOf(value: unknown): PreviewSelectionsTarget | undefined | null {
	if (value === undefined) return undefined;
	const record = recordOf(value);
	if (record === undefined || typeof record.formUuid !== "string") return null;
	const cases =
		record.cases === undefined ? undefined : caseChoicesOf(record.cases);
	if (record.cases !== undefined && cases === undefined) return null;
	const { caseListSearchText } = record;
	if (
		caseListSearchText !== undefined &&
		typeof caseListSearchText !== "string"
	)
		return null;
	const chosenAfter = recordOf(record.formChosenAfterCase);
	if (
		record.formChosenAfterCase !== undefined &&
		(chosenAfter === undefined ||
			typeof chosenAfter.caseListModuleUuid !== "string" ||
			(chosenAfter.fromCaseListMenu !== undefined &&
				chosenAfter.fromCaseListMenu !== true))
	)
		return null;
	return {
		formUuid: record.formUuid as Uuid,
		...(cases !== undefined && {
			cases: cases.map(({ caseId, caseName, claimable }) => ({
				caseId,
				...(caseName !== undefined && { caseName }),
				...(claimable === true && { claimable }),
			})) as PreviewCaseChoice[],
		}),
		...(caseListSearchText !== undefined && { caseListSearchText }),
		...(chosenAfter !== undefined && {
			formChosenAfterCase: {
				caseListModuleUuid: chosenAfter.caseListModuleUuid as Uuid,
				...(chosenAfter.fromCaseListMenu === true && {
					fromCaseListMenu: true as const,
				}),
			},
		}),
	};
}

function selectedOf(value: unknown): PreviewSelectedCase | undefined | null {
	if (value === undefined) return undefined;
	const record = recordOf(value);
	return record !== undefined &&
		typeof record.caseId === "string" &&
		typeof record.caseName === "string"
		? { caseId: record.caseId, caseName: record.caseName }
		: null;
}

/** The selections a history entry's state records, or none where the value
 *  is not one: a state is anything a page wrote into history. */
export function readPreviewSelections(
	state: unknown,
): RecordedPreviewSelections | undefined {
	const record = recordOf(recordOf(state)?.[PREVIEW_SELECTIONS_STATE_KEY]);
	if (
		record === undefined ||
		typeof record.session !== "string" ||
		typeof record.task !== "string"
	)
		return undefined;
	const menu = menuOf(record.menu);
	const target = targetOf(record.target);
	const selected = selectedOf(record.selected);
	if (menu === undefined || target === null || selected === null)
		return undefined;
	return { session: record.session, task: record.task, menu, target, selected };
}

/** The selections of a case target: the form and its cases, and how they
 *  were chosen. */
export function previewSelectionsTargetOf(
	target: PreviewCaseTarget | undefined,
): PreviewSelectionsTarget | undefined {
	if (target === undefined) return undefined;
	return {
		formUuid: target.formUuid,
		...(target.cases !== undefined && {
			cases: target.cases.map(({ caseId, caseName, claimable }) => ({
				caseId,
				...(caseName !== undefined && { caseName }),
				...(claimable === true && { claimable }),
			})),
		}),
		...(target.caseListSearchText !== undefined && {
			caseListSearchText: target.caseListSearchText,
		}),
		...(target.formChosenAfterCase !== undefined && {
			formChosenAfterCase: { ...target.formChosenAfterCase },
		}),
	};
}

function storedSelections(
	recorded: RecordedPreviewSelections,
): Record<string, unknown> {
	return {
		session: recorded.session,
		task: recorded.task,
		menu: Object.fromEntries(
			Object.entries(recorded.menu).map(([moduleUuid, selection]) => [
				moduleUuid,
				{
					caseType: selection.caseType,
					cases: selection.cases.map((choice) => ({
						...choice,
						...(choice.caseProperties !== undefined && {
							caseProperties: { ...choice.caseProperties },
						}),
					})),
				},
			]),
		),
		...(recorded.target !== undefined && {
			target: previewSelectionsTargetOf(recorded.target as PreviewCaseTarget),
		}),
		...(recorded.selected !== undefined && {
			selected: { ...recorded.selected },
		}),
	};
}

/** The state with these selections recorded on it, its address, held menu
 *  and every other record kept. */
export function withPreviewSelections(
	state: unknown,
	recorded: RecordedPreviewSelections,
): Record<string, unknown> {
	return {
		...(recordOf(state) ?? {}),
		[PREVIEW_SELECTIONS_STATE_KEY]: storedSelections(recorded),
	};
}

/** Whether two records say the same: one comparison over their stored
 *  form, which is plain JSON. */
export function samePreviewSelections(
	a: RecordedPreviewSelections | undefined,
	b: RecordedPreviewSelections | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return (
		JSON.stringify(storedSelections(a)) === JSON.stringify(storedSelections(b))
	);
}

/**
 * What Back or Forward onto a history entry does with the session's
 * selections.
 *
 * - `restore`: on Web Apps, an entry off Home shown in this Preview session
 *   in another task (Home ended that task since): its selections become the
 *   session's and the session takes up its task again, ending what is left
 *   of the later one, as Formplayer replays a popped address's selections
 *   into a new session.
 * - `replay`: on Web Apps, an entry off Home shown in this task with
 *   selections other than the session's (a crumb let a case go since, or a
 *   later screen chose another case): its selections become the session's,
 *   as Formplayer replays every popped address's selections
 *   (`MenuSessionRunnerService.advanceSessionWithSelections`), and the rest
 *   of the task stands.
 * - `keep`: everything else. An entry the session already shows needs
 *   nothing; an entry of an earlier session names cases no worker of this one
 *   chose; Home clears the selections itself; and on Android the session as
 *   it stands is what any entry shows.
 */
export type PreviewSelectionsArrival =
	| { readonly kind: "keep" }
	| {
			readonly kind: "restore" | "replay";
			readonly recorded: RecordedPreviewSelections;
	  };

export function previewSelectionsArrival(args: {
	readonly replay: "address" | "session";
	readonly atHome: boolean;
	readonly onEntry: RecordedPreviewSelections | undefined;
	readonly session: string;
	readonly task: string;
	/** The selections the session holds as the worker arrives. */
	readonly current: PreviewSessionSelections;
}): PreviewSelectionsArrival {
	const { onEntry } = args;
	if (
		args.replay !== "address" ||
		args.atHome ||
		onEntry === undefined ||
		onEntry.session !== args.session
	)
		return { kind: "keep" };
	if (onEntry.task !== args.task) return { kind: "restore", recorded: onEntry };
	return samePreviewSelections(onEntry, {
		...args.current,
		session: onEntry.session,
		task: onEntry.task,
	})
		? { kind: "keep" }
		: { kind: "replay", recorded: onEntry };
}

/** The recorded selections the document still names: a menu or a form an
 *  edit removed since holds nothing. */
export function previewSelectionsInDocument(
	recorded: RecordedPreviewSelections,
	doc: {
		readonly modules: Readonly<Record<string, unknown>>;
		readonly forms: Readonly<Record<string, unknown>>;
	},
): {
	readonly task: string;
	readonly menu: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly target: PreviewSelectionsTarget | undefined;
	readonly selected: PreviewSelectedCase | undefined;
} {
	return {
		task: recorded.task,
		menu: Object.fromEntries(
			Object.entries(recorded.menu).filter(([moduleUuid]) =>
				Object.hasOwn(doc.modules, moduleUuid),
			),
		),
		target:
			recorded.target !== undefined &&
			Object.hasOwn(doc.forms, recorded.target.formUuid)
				? recorded.target
				: undefined,
		selected: recorded.selected,
	};
}

/** The state without the recorded selections: a write's new entry records
 *  its own, and a state another generation of the Project wrote names its
 *  cases. */
export function withoutPreviewSelections(
	state: Record<string, unknown>,
): Record<string, unknown> {
	const { [PREVIEW_SELECTIONS_STATE_KEY]: _selections, ...rest } = state;
	return rest;
}
