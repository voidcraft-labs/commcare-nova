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
 * its entry keeps the mark. Each entry a write pushes also records the entry
 * it was pushed after (`previous`); a replace, and a language change's copy
 * of the screen, keep the entry before the screen they stand for, with how
 * many entries lie between (`gapOf`). That is how the menu knows whether the
 * entry before it is its list's (`afterList`), whether it was pushed from the
 * list or replaced a case's details, or a copy of them under another
 * language, so its own Back can step back past every entry of the one step
 * at once, as a device, which has no language history, steps back once
 * (`previewHeldMenuBack`), and how a form opened from the menu knows the menu
 * is the entry before it, so the crumb of the menu's case steps back onto it
 * (`previewHeldMenuIsPrevious`), opening it again where the entry it lands on
 * no longer holds it (`previewHeldMenuStands`).
 */
import type { Uuid } from "@/lib/doc/types";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import type { PreviewCaseChoice } from "@/lib/session/types";
import { withoutPreviewSelections } from "./previewSelectionsHistory";

const HELD_MENU_STATE_KEY = "__novaPreviewHeldMenu";
const PREVIOUS_ENTRY_STATE_KEY = "__novaPreviousEntry";
const PREVIOUS_GAP_STATE_KEY = "__novaPreviousGap";

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

/** How many entries lie between an entry and the one it records as the
 *  entry before its screen (`previous`): a language change's copies of the
 *  screen, and the entries a replace left behind it, each one. */
function gapOf(state: unknown): number {
	const gap = recordOf(state)?.[PREVIOUS_GAP_STATE_KEY];
	return typeof gap === "number" && Number.isSafeInteger(gap) && gap > 0
		? gap
		: 0;
}

/** Whether the entry before the menu's own entry is its list's. */
function afterListOf(state: unknown): boolean {
	return recordOf(recordOf(state)?.[HELD_MENU_STATE_KEY])?.afterList === true;
}

/** How many history entries a step back off the held menu of this state
 * passes to reach the entry before it: its own, one for each language
 * change made on it, and one for each entry of the screen the menu replaced
 * still behind it (a case's details, and their copies under another
 * language). None without a held menu. */
export function stepsOfPreviewHeldMenu(state: unknown): number {
	return readPreviewHeldMenu(state) === undefined ? 0 : gapOf(state) + 1;
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

/** The state without the held menu, the entry before it or the case
 *  selections it was shown with (`previewSelectionsHistory.ts`): a state
 *  another generation of the Project wrote names its cases, and a write's new
 *  entry records the selections it is shown with itself. */
export function withoutPreviewHistorySteps(
	state: Record<string, unknown>,
): Record<string, unknown> {
	const {
		[HELD_MENU_STATE_KEY]: _held,
		[PREVIOUS_ENTRY_STATE_KEY]: _previous,
		[PREVIOUS_GAP_STATE_KEY]: _gap,
		...rest
	} = state;
	return withoutPreviewSelections(rest);
}

const RESULTS_SEGMENT = "/results";
/** The module's URLs Preview shows the running list at: Results, the
 *  Search and Details authoring tabs and the data review screen, which
 *  preview as the same list (`PreviewShell`'s `caseList` identity). */
const LIST_SEGMENTS = [RESULTS_SEGMENT, "/search", "/details", "/data-review"];

/** Whether `path` is the entry of the list a held menu's entry at `heldPath`
 *  (the list's Results URL) belongs to: any URL of the module Preview shows
 *  that list at. */
function isListPath(path: string, heldPath: string): boolean {
	if (!heldPath.endsWith(RESULTS_SEGMENT)) return path === heldPath;
	const moduleUrl = heldPath.slice(0, -RESULTS_SEGMENT.length);
	return LIST_SEGMENTS.some((segment) => path === `${moduleUrl}${segment}`);
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
 * with the entry it was pushed after (a replace and a lens copy keep the
 * replaced or copied entry's). A held menu is after its list where that
 * entry is the list's own (at a URL of its module Preview shows the list at:
 * Results, Search, Details or data review), holding nothing in the session taking the
 * step: pushed from the list, or in place of a case's details pushed from
 * it (or their copy under another language), where that entry holds no menu or
 * one an earlier Preview session held, which shows the list now
 * (`menuProjection.ts::previewCaseListHeldChoices`). A menu opened anywhere
 * else (a crumb's from a form, a deep-linked case's details with nothing
 * before them) is not.
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
	/* A push records the entry it was pushed after. A replace, and a lens
	 * copy of the screen, keep the entry before the screen they stand for,
	 * one entry further from it for a lens copy, so a menu that replaces a
	 * case's details, or a copy of them under another language, still knows
	 * its list is behind them. */
	const carries = lens || write.replace;
	const previous: PreviousEntry | undefined = carries
		? previousEntryOf(current.state)
		: {
				path: current.pathname,
				held: readPreviewHeldMenu(current.state),
			};
	const gap = carries ? gapOf(current.state) + (lens ? 1 : 0) : 0;
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
							showsListIn(previous, held.session) &&
							isListPath(previous.path, write.pathname)) && {
						afterList: true,
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
			...(gap > 0 && { [PREVIOUS_GAP_STATE_KEY]: gap }),
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

/** How many history entries a step back from this entry passes to reach
 *  the entry its screen was pushed after, where that entry is the plain
 *  screen at `pathname` (it holds no form menu): its own, and one for each
 *  entry between them (`gapOf`, a language change's copies of the screen).
 *  None where the entry before is any other screen, or is not recorded. A
 *  screen whose own Back reaches the screen it was opened from (a parent
 *  case's list going back over the command that asked for it,
 *  `CommCareSession.stepBack`) steps back by this count rather than writing
 *  a copy of that screen after itself, which would leave the screen twice
 *  in history and make the browser's next Back land on it again. The entry
 *  behind can have changed since it was recorded, so the step is checked
 *  where it lands (`useClientPath.ts::stepBackToBuilderEntry`). */
export function stepsBackToPrevious(
	state: unknown,
	pathname: string,
): number | undefined {
	const previous = previousEntryOf(state);
	return previous !== undefined &&
		previous.held === undefined &&
		previous.path === pathname
		? gapOf(state) + 1
		: undefined;
}

/** Whether an entry shows its list in a Preview session: it holds no menu,
 *  or holds one another session took, which that list ignores. */
function showsListIn(entry: PreviousEntry, session: string): boolean {
	return entry.held === undefined || entry.held.session !== session;
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
 *  menu, as a device's step back off the form lands there. A copy of the
 *  form under another language is not right after the menu. The entry it
 *  records can have changed since (the menu's own Back shows the list in its
 *  entry, and Forward returns to the form), so the step back is checked
 *  where it lands (`previewHeldMenuStands`). */
export function previewHeldMenuIsPrevious(
	state: unknown,
	held: PreviewHeldCaseListMenu,
): boolean {
	if (readPreviewHeldMenu(state) !== undefined || gapOf(state) > 0)
		return false;
	const previous = previousEntryOf(state)?.held;
	return previous !== undefined && sameHeldMenu(previous, held);
}

/** Whether an entry holds this held menu: where a step back onto the menu
 *  lands on an entry that no longer holds it, the menu opens again on an
 *  entry of its own. */
export function previewHeldMenuStands(
	state: unknown,
	held: PreviewHeldCaseListMenu,
): boolean {
	const current = readPreviewHeldMenu(state);
	return current !== undefined && sameHeldMenu(current, held);
}
