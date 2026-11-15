/**
 * The history entry of a case list's own form menu in Preview. Choosing a
 * case on such a list (`CaseListScreen`) opens a step of the session between
 * the list and the form: the menu with the case held. A device steps back
 * off a form chosen there onto that menu, and off the menu onto the list with
 * the case let go (`CommCareSession.stepBack`), so the menu has a place of its
 * own in the browser's history: an entry at the list's URL that carries the
 * held cases in its history state. Back, Forward and the strip's Go back then
 * walk the same steps a device does, and the list shows its menu exactly on
 * the entries that hold one, in the Preview session that took the step
 * (`menuProjection.ts::previewCaseListHeldChoices`).
 *
 * `builderEntryState` decides every builder history write's state
 * (`useClientPath.ts` applies it): the mark is written only where the write
 * names a held menu, and every other write drops it, so no entry inherits a
 * menu it did not open. A language change is a lens on the screen on show, so
 * its entry keeps the mark one lens deeper (`lensDepth`). Each entry a write
 * pushes also records the entry it was pushed after (`previous`), a replace
 * keeping the replaced entry's: that is how the menu knows whether the entry
 * before it is its list's (`afterList`), so its own Back can step back past
 * every entry of the one step at once, as a device, which has no language
 * history, steps back once (`previewHeldMenuBack`), and how a form opened
 * from the menu knows the menu is the entry before it, so the crumb of the
 * menu's case steps back onto it (`previewHeldMenuIsPrevious`).
 */
import type { Uuid } from "@/lib/doc/types";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import type { PreviewCaseChoice } from "@/lib/session/types";

const HELD_MENU_STATE_KEY = "__novaPreviewHeldMenu";
const PREVIOUS_ENTRY_STATE_KEY = "__novaPreviousEntry";

function caseChoiceOf(value: unknown): PreviewCaseChoice | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { caseId, caseName, claimable } = value as Record<string, unknown>;
	if (typeof caseId !== "string") return undefined;
	if (caseName !== undefined && typeof caseName !== "string") return undefined;
	if (claimable !== undefined && claimable !== true) return undefined;
	return {
		caseId,
		...(caseName !== undefined && { caseName }),
		...(claimable === true && { claimable }),
	};
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** A held menu read from its stored value, or none where the value is not
 *  one: a state is anything a page wrote into history. */
export function previewHeldMenuOf(
	held: unknown,
): PreviewHeldCaseListMenu | undefined {
	const record = recordOf(held);
	if (record === undefined) return undefined;
	const { moduleUuid, cases, session } = record;
	if (
		typeof moduleUuid !== "string" ||
		typeof session !== "string" ||
		!Array.isArray(cases)
	)
		return undefined;
	const choices = cases.map(caseChoiceOf);
	if (choices.length === 0 || choices.some((choice) => choice === undefined))
		return undefined;
	return {
		moduleUuid: moduleUuid as Uuid,
		cases: choices as PreviewCaseChoice[],
		session,
	};
}

/** The held menu a history entry's state carries, or none. */
export function readPreviewHeldMenu(
	state: unknown,
): PreviewHeldCaseListMenu | undefined {
	return previewHeldMenuOf(recordOf(state)?.[HELD_MENU_STATE_KEY]);
}

/** The language changes made on the menu's own entry before this one. */
function lensDepthOf(state: unknown): number {
	const depth = recordOf(recordOf(state)?.[HELD_MENU_STATE_KEY])?.lensDepth;
	return typeof depth === "number" && Number.isSafeInteger(depth) && depth > 0
		? depth
		: 0;
}

/** Whether the entry before the menu's own entry is its list's. */
function afterListOf(state: unknown): boolean {
	return recordOf(recordOf(state)?.[HELD_MENU_STATE_KEY])?.afterList === true;
}

/** How many history entries the held menu of this state takes: its own,
 * and one for each language change made on it. None without a held menu. */
export function stepsOfPreviewHeldMenu(state: unknown): number {
	return readPreviewHeldMenu(state) === undefined ? 0 : lensDepthOf(state) + 1;
}

/** The entry a history entry was pushed after: its path and the held menu
 *  it carried. */
interface PreviousEntry {
	readonly path: string;
	readonly held: PreviewHeldCaseListMenu | undefined;
}

function previousEntryOf(state: unknown): PreviousEntry | undefined {
	const previous = recordOf(recordOf(state)?.[PREVIOUS_ENTRY_STATE_KEY]);
	if (previous === undefined || typeof previous.path !== "string")
		return undefined;
	return { path: previous.path, held: previewHeldMenuOf(previous.held) };
}

function storedHeldMenu(held: PreviewHeldCaseListMenu) {
	return {
		moduleUuid: held.moduleUuid,
		cases: held.cases.map((choice) => ({ ...choice })),
		session: held.session,
	};
}

/** The state without the held menu or the entry before it: a state another
 *  generation of the Project wrote names its cases. */
export function withoutPreviewHistorySteps(
	state: Record<string, unknown>,
): Record<string, unknown> {
	const {
		[HELD_MENU_STATE_KEY]: _held,
		[PREVIOUS_ENTRY_STATE_KEY]: _previous,
		...rest
	} = state;
	return rest;
}

const RESULTS_SEGMENT = "/results";

/** Whether `path` is the entry of the list a held menu's entry at `heldPath`
 *  (the list's Results URL) belongs to: that URL, or its module's, where a
 *  menu that chooses its case first shows its list. */
function isListPath(path: string, heldPath: string): boolean {
	return (
		path === heldPath ||
		(heldPath.endsWith(RESULTS_SEGMENT) &&
			path === heldPath.slice(0, -RESULTS_SEGMENT.length))
	);
}

/** One builder history write: the path it writes, whether it replaces the
 *  current entry, and the held menu it opens, or, for a lens write (a
 *  language change, always a push), the screen's own held menu kept. */
export type BuilderHistoryWrite =
	| {
			readonly pathname: string;
			readonly replace: boolean;
			readonly held?: PreviewHeldCaseListMenu;
	  }
	| { readonly pathname: string; readonly lens: true };

/**
 * The state of the entry a builder history write leaves: the current entry's
 * state, less its held menu unless the write names one or keeps it as a lens,
 * with the entry it was pushed after (a replace keeps the replaced entry's).
 * A held menu is after its list where that entry is the list's own (at its
 * Results URL or, for a menu that chooses its case first, its module's),
 * holding nothing: pushed from the list, or in place of a case's details
 * pushed from it. A menu opened anywhere else (a crumb's from a form, a deep-linked
 * case's details with nothing before them) is not.
 */
export function builderEntryState(
	current: {
		readonly pathname: string;
		readonly state: Record<string, unknown>;
	},
	write: BuilderHistoryWrite,
): Record<string, unknown> {
	const rest = withoutPreviewHistorySteps(current.state);
	const lens = "lens" in write;
	const previous: PreviousEntry | undefined =
		!lens && write.replace
			? previousEntryOf(current.state)
			: {
					path: current.pathname,
					held: readPreviewHeldMenu(current.state),
				};
	const kept = lens ? readPreviewHeldMenu(current.state) : undefined;
	const held = lens ? kept : write.held;
	const stored =
		held === undefined
			? undefined
			: {
					...storedHeldMenu(held),
					...((lens
						? afterListOf(current.state)
						: previous !== undefined &&
							previous.held === undefined &&
							isListPath(previous.path, write.pathname)) && {
						afterList: true,
					}),
					...(lens && {
						lensDepth: stepsOfPreviewHeldMenu(current.state),
					}),
				};
	return {
		...rest,
		...(previous !== undefined && {
			[PREVIOUS_ENTRY_STATE_KEY]: {
				path: previous.path,
				...(previous.held !== undefined && {
					held: storedHeldMenu(previous.held),
				}),
			},
		}),
		...(stored !== undefined && { [HELD_MENU_STATE_KEY]: stored }),
	};
}

/**
 * What the held menu's own Back does on an entry, a device's step back off
 * the menu onto its list with the cases let go (`CommCareSession.stepBack`):
 * where the entry before the menu is the list's, step back past every entry
 * of the menu's one step; otherwise there is no list entry behind it to step
 * back to, so the menu's entry becomes the list's. An entry with no held menu
 * steps back once.
 */
export type PreviewHeldMenuBack =
	| { readonly kind: "step-back"; readonly steps: number }
	| { readonly kind: "show-list" };

export function previewHeldMenuBack(state: unknown): PreviewHeldMenuBack {
	if (readPreviewHeldMenu(state) === undefined)
		return { kind: "step-back", steps: 1 };
	return afterListOf(state)
		? { kind: "step-back", steps: stepsOfPreviewHeldMenu(state) }
		: { kind: "show-list" };
}

function sameHeldMenu(
	a: PreviewHeldCaseListMenu,
	b: PreviewHeldCaseListMenu,
): boolean {
	return (
		a.moduleUuid === b.moduleUuid &&
		a.session === b.session &&
		a.cases.length === b.cases.length &&
		a.cases.every((choice, i) => choice.caseId === b.cases[i]?.caseId)
	);
}

/** Whether the entry before this one is this held menu's own: a form opened
 *  from the menu, whose crumb of the menu's case then steps back onto the
 *  menu, as a device's step back off the form lands there. */
export function previewHeldMenuIsPrevious(
	state: unknown,
	held: PreviewHeldCaseListMenu,
): boolean {
	if (readPreviewHeldMenu(state) !== undefined) return false;
	const previous = previousEntryOf(state)?.held;
	return previous !== undefined && sameHeldMenu(previous, held);
}
