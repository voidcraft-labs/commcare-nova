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
 * new task (`previewTaskId`). So the session keeps, for each entry it shows,
 * the cases the store held while it was shown and the task it was shown in,
 * in the entry's record (`previewEntryRecords.ts`): in memory, by the entry's
 * id, never in the browser's history, which would keep the cases past the
 * session, the sign-in and the Project membership that read them. An arrival
 * in the same session and another task (Back or Forward past Home) puts them
 * back before any screen reads them, taking that task up again; an entry of
 * an earlier session has no record in this one. Within one task the session can have moved on from what
 * an entry shows (a crumb let a case go, a later list chose another), and Web
 * Apps replays the popped address's selections there too, so an arrival puts
 * the entry's selections back wherever they differ from the session's.
 *
 * Android has no address: Preview's browser history stands for nothing a
 * phone keeps, and its Back is the device's step back
 * (`CommCareSession.stepBack`, modelled on the screens), so on Android the
 * session as it stands is what an entry shows (`rules.poppedEntrySelections`).
 */
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewSelectedCase,
} from "@/lib/session/types";

/** The part of a form's case target that is the session's selections: the
 *  form and the cases chosen for it, and how they were chosen. What a target
 *  carries beyond that (a Register launch, a link's device world) belongs to
 *  the one entry of the form that launch opened, never to an address. */
export type PreviewSelectionsTarget = Pick<
	PreviewCaseTarget,
	| "formUuid"
	| "cases"
	| "entryChoices"
	| "opening"
	| "caseListSearchText"
	| "formChosenAfterCase"
>;

/** The session's case selections, as the store holds them. */
export interface PreviewSessionSelections {
	readonly menu: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly target: PreviewSelectionsTarget | undefined;
	readonly selected: PreviewSelectedCase | undefined;
}

/** What an entry's record holds: the selections it was shown with, and the
 *  task of the session they were held in. The record is the session's own
 *  (`previewEntryRecords.ts`), so it names no session. */
export interface RecordedPreviewSelections extends PreviewSessionSelections {
	readonly task: string;
}

/** The selections of a case target: the form and its cases, and how they
 *  were chosen. */
export function previewSelectionsTargetOf(
	target: PreviewCaseTarget | undefined,
): PreviewSelectionsTarget | undefined {
	if (target === undefined) return undefined;
	return {
		formUuid: target.formUuid,
		...(target.opening && { opening: target.opening }),
		...(target.entryChoices && {
			entryChoices: target.entryChoices.map((choice) => ({ ...choice })),
		}),
		...(target.cases !== undefined && {
			cases: target.cases.map(
				({ caseId, caseName, caseType, searchSource, claimable }) => ({
					caseId,
					...(caseName !== undefined && { caseName }),
					...(caseType && { caseType }),
					...(searchSource && { searchSource }),
					...(claimable === true && { claimable }),
				}),
			),
		}),
		...(target.caseListSearchText !== undefined && {
			caseListSearchText: target.caseListSearchText,
		}),
		...(target.formChosenAfterCase !== undefined && {
			formChosenAfterCase: { ...target.formChosenAfterCase },
		}),
	};
}

/** Selections in one comparable form: the target as its selections. */
function comparable(recorded: RecordedPreviewSelections): string {
	const target = previewSelectionsTargetOf(
		recorded.target as PreviewCaseTarget,
	);
	return JSON.stringify({
		task: recorded.task,
		menu: recorded.menu,
		target: target && {
			...target,
			opening: target.opening?.binding.evidence.signature,
		},
		selected: recorded.selected,
	});
}

/** Whether two records say the same. */
export function samePreviewSelections(
	a: RecordedPreviewSelections | undefined,
	b: RecordedPreviewSelections | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return comparable(a) === comparable(b);
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
 *   nothing; an entry of an earlier session has no record in this one;
 *   Home clears the selections itself; and on Android the session as it
 *   stands is what any entry shows.
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
	/** The record of the entry in the running Preview session: none where
	 *  that session did not show it. */
	readonly onEntry: RecordedPreviewSelections | undefined;
	readonly task: string;
	/** The selections the session holds as the worker arrives. */
	readonly current: PreviewSessionSelections;
}): PreviewSelectionsArrival {
	const { onEntry } = args;
	if (args.atHome || onEntry === undefined) return { kind: "keep" };
	if (args.replay !== "address") {
		// Android Back in a form-local entry unwinds every non-user step
		// through the last manual choice, even when both steps show one URL.
		const prior = onEntry.target;
		const current = args.current.target;
		if (
			onEntry.task !== args.task ||
			!prior?.entryChoices ||
			!current?.entryChoices ||
			prior.formUuid !== current.formUuid
		)
			return { kind: "keep" };
	}

	if (onEntry.task !== args.task) return { kind: "restore", recorded: onEntry };
	return samePreviewSelections(onEntry, {
		...args.current,
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
