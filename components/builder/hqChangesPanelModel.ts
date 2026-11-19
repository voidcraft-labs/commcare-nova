/**
 * The changes made in CommCare HQ panel, as state: the review it is waiting
 * on, the answer it shows, the bring-in it sends, and what the surface that
 * holds it (the publish dialog, or the Publishing card's dialog) does with
 * each answer.
 *
 * Pure, so every state and transition is tested here; `HqChangesPanel` sends
 * the request `nextRequest` names, dispatches what it answers, and draws
 * `panelView`. No state between the review's start and its answer offers a
 * choice, no choice can be pressed while a bring-in runs, and a review that
 * finds nothing to bring in but a read to record sends that bring-in once.
 */

import { broughtInOf } from "@/components/builder/app-setup/publishingSectionModel";
import { isDeploymentServer, type LookupTableChoice } from "@/lib/deployment";
import type {
	DeploymentActionResult,
	DeploymentView,
	KeptRefreshView,
} from "@/lib/deployment/actions";
import type {
	HqChangesOutcome,
	HqChangesReview,
	HqChangesStage,
} from "@/lib/deployment/hqChanges/types";
import type { RemoteChangeDiscard } from "@/lib/deployment/types";
import type {
	DriftDateOptions,
	DriftReference,
} from "@/lib/publish/driftReference";
import {
	BRING_IN_CHANGES_ACTION,
	broughtInLine,
	CANNOT_BRING_IN_HEADING,
	CANNOT_BRING_IN_OTHER_WAYS,
	CANNOT_BRING_IN_TOO_LARGE_LEAD,
	cannotBringInLead,
	HQ_CHANGES_BRING_IN_LOST_LINE,
	HQ_CHANGES_FAILED_LINE,
	HQ_CHANGES_GATE_LEAD,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_HEADING,
	HQ_CHANGES_NOTHING_TAKEN_LINE,
	HQ_CHANGES_REVIEW_LOST_LINE,
	HQ_CHANGES_STAGE_LABELS,
	hqChangesHeldLine,
	hqChangesLead,
	hqChangesMovedLine,
	hqChangesUnavailableLine,
	NOVA_CHANGES_HEADING,
	NOVA_CHANGES_LEAD,
	nothingToBringInLine,
	PUBLISH_OVER_HQ_ACTION,
	PUBLISH_OVER_HQ_HELPER,
	PUBLISH_OVER_INSTEAD_LINE,
	renamedInNovaLine,
	sincePhrase,
	USE_HQ_VERSION_ACTION,
	USE_HQ_VERSION_HELPER,
} from "@/lib/publish/hqChangesCopy";
import type { CircumstanceFinding } from "@/lib/publish/hqFindings";
import type { HqChangedTarget } from "@/lib/session/hooks";

/** Where the panel is drawn: in the publish dialog's stop, or in the Publishing card's dialog. */
export type HqChangesPanelHome = "publish" | "card";

/** Of the files a stage handles, how many are done. */
export type FileCount = { readonly done: number; readonly total: number };

/** Where a request in flight has got, and when it started (milliseconds). */
export interface HqChangesProgressState {
	readonly stage: HqChangesStage | null;
	readonly files: FileCount | null;
	readonly startedAt: number;
}

type ChangesReview = Extract<HqChangesReview, { kind: "changes" }>;
type NothingReview = Extract<HqChangesReview, { kind: "nothing" }>;
type AccountReview = Extract<HqChangesReview, { kind: "account" }>;

/** A review a bring-in can be sent for: one with a reading and a digest. */
export type ReviewToBringIn =
	| ChangesReview
	| (NothingReview & {
			readonly readingId: string;
			readonly reviewDigest: string;
	  });

/**
 * How a request ended with no answer: lost on the way, failed on Nova's
 * side, or refused by its route before anything was read (the member can no
 * longer edit the app, their session ended, a body the route can't read),
 * with the route's own sentence and whether checking again can help.
 */
export type RequestEnd =
	| "lost"
	| "failed"
	| { readonly message: string; readonly checkAgain: boolean };

/** What stands beside a review's lists after a bring-in that took nothing, with the buttons back. */
export type BringInNotice =
	| { readonly kind: "gate"; readonly findings: readonly string[] }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "ended"; readonly end: RequestEnd };

export type HqChangesPanelPhase =
	/** The review is on its way. */
	| { readonly kind: "loading"; readonly progress: HqChangesProgressState }
	/** The review ended with no answer. */
	| { readonly kind: "unanswered"; readonly end: RequestEnd }
	/** The review answered. */
	| {
			readonly kind: "answered";
			readonly review: HqChangesReview;
			readonly notice: BringInNotice | null;
	  }
	/** A bring-in is on its way for `review`. */
	| {
			readonly kind: "bringing-in";
			readonly review: ReviewToBringIn;
			/** The bring-in removes the changes listed under Nova. */
			readonly discard: boolean;
			readonly progress: HqChangesProgressState;
	  }
	/** The bring-in answered: the changes are in, or the read is recorded. */
	| {
			readonly kind: "settled";
			readonly review: ReviewToBringIn | NothingReview;
			readonly outcome: Extract<
				HqChangesOutcome,
				{ kind: "brought-in" | "recorded" }
			> | null;
	  };

/** What the surface that holds the panel does once it settles. */
export type HqChangesSettled =
	/**
	 * There was nothing to bring in, and what CommCare HQ holds is recorded
	 * where there was something to record (`deployment`, null where nothing
	 * was). `publishChanges`: what the next publish changes in CommCare HQ.
	 */
	| {
			readonly kind: "nothing";
			readonly deployment: DeploymentView | null;
			readonly publishChanges: readonly string[];
	  }
	/**
	 * The changes are in the app now. `deployment` is the record, null where
	 * Nova could not read it after the bring-in landed, so the surface reads
	 * its records again.
	 */
	| {
			readonly kind: "brought-in";
			readonly deployment: DeploymentView | null;
			readonly discarded: boolean;
	  };

/** A request the panel is to send. */
export type HqChangesRequest =
	| { readonly id: number; readonly kind: "review" }
	| {
			readonly id: number;
			readonly kind: "bring-in";
			readonly readingId: string;
			readonly reviewDigest: string;
			readonly tableChoices: Readonly<Record<string, LookupTableChoice>>;
	  };

export interface HqChangesPanelState {
	readonly phase: HqChangesPanelPhase;
	/**
	 * The latest request and whether it has been sent; once it is answered it
	 * stays as sent, so ids only grow and no id is named twice.
	 */
	readonly request: { readonly id: number; readonly sent: boolean };
	/** The review moved under the person, and the member whose edit moved it. */
	readonly moved: { readonly editedBy: string | null } | null;
	/** Each table's answer, by tag. */
	readonly tableChoices: Readonly<Record<string, LookupTableChoice>>;
	/** Set where a bring-in was pressed with a table unanswered; each press is a new nonce. */
	readonly needsChoice: { readonly nonce: number } | null;
	/** The lists opened past their first ten lines. */
	readonly shownAll: { readonly hq: boolean; readonly nova: boolean };
	/** The answer to Copy both lists, until it is cleared. */
	readonly copy: "idle" | "copied" | "refused";
	/**
	 * The digests of the `nothing` reviews whose record was answered: recorded,
	 * or answered with the review moved. Each is sent by itself once it is
	 * answered no more; a record that ended with no answer or was refused is
	 * sent again when Check again reads the same review.
	 */
	readonly recordedDigests: readonly string[];
	/** What the holding surface does now; a new `id` each time it settles. */
	readonly settled: (HqChangesSettled & { readonly id: number }) | null;
}

export type HqChangesPanelEvent =
	/** Ask for a review: on open, and on Check again. */
	| { readonly type: "check"; readonly at: number }
	/** The request `id` names was sent. */
	| { readonly type: "sent"; readonly id: number }
	| { readonly type: "stage"; readonly stage: HqChangesStage }
	| { readonly type: "files"; readonly done: number; readonly total: number }
	| { readonly type: "review-answered"; readonly review: HqChangesReview }
	| { readonly type: "review-ended"; readonly end: RequestEnd }
	/** Bring in these changes (`discard` false) or Use CommCare HQ's version (`discard` true). */
	| {
			readonly type: "bring-in-pressed";
			readonly discard: boolean;
			readonly at: number;
	  }
	| { readonly type: "bring-in-answered"; readonly outcome: HqChangesOutcome }
	| { readonly type: "bring-in-ended"; readonly end: RequestEnd }
	| {
			readonly type: "table-chosen";
			readonly tag: string;
			readonly choice: LookupTableChoice;
	  }
	| { readonly type: "show-all"; readonly list: "hq" | "nova" }
	| { readonly type: "copied" }
	| { readonly type: "copy-refused" }
	| { readonly type: "copy-cleared" };

/** The state a panel opens in: its review on its way, not yet sent. */
export function initialHqChangesPanel(at: number): HqChangesPanelState {
	return {
		phase: { kind: "loading", progress: freshProgress(at) },
		request: { id: 1, sent: false },
		moved: null,
		tableChoices: {},
		needsChoice: null,
		shownAll: { hq: false, nova: false },
		copy: "idle",
		recordedDigests: [],
		settled: null,
	};
}

function freshProgress(at: number): HqChangesProgressState {
	return { stage: null, files: null, startedAt: at };
}

function nextRequestId(state: HqChangesPanelState): number {
	return state.request.id + 1;
}

/** The latest request, answered: nothing is waiting to be sent. */
function answeredRequest(state: HqChangesPanelState): {
	readonly id: number;
	readonly sent: true;
} {
	return { id: state.request.id, sent: true };
}

function nextSettledId(state: HqChangesPanelState): number {
	return (state.settled?.id ?? 0) + 1;
}

/** The tables of a review that ask their choice. */
export function choiceTables(review: ChangesReview): ChangesReview["tables"] {
	return review.tables.filter((table) => table.standing === "choice");
}

function unansweredTables(
	review: ChangesReview,
	choices: Readonly<Record<string, LookupTableChoice>>,
): boolean {
	return choiceTables(review).some((table) => choices[table.tag] === undefined);
}

/** A `nothing` review whose read is to be recorded: it holds a digest not yet sent. */
function recordable(
	review: HqChangesReview,
	state: HqChangesPanelState,
): review is NothingReview & {
	readonly readingId: string;
	readonly reviewDigest: string;
} {
	return (
		review.kind === "nothing" &&
		review.readingId !== null &&
		review.reviewDigest !== null &&
		!state.recordedDigests.includes(review.reviewDigest)
	);
}

/**
 * The state once a review answered: a `nothing` that holds a read to record
 * sends its bring-in at once, until one is answered; a `nothing` with
 * nothing to record settles; every other review waits for the person.
 */
function withReview(
	state: HqChangesPanelState,
	review: HqChangesReview,
	at: number,
): HqChangesPanelState {
	const base: HqChangesPanelState = {
		...state,
		needsChoice: null,
		shownAll: { hq: false, nova: false },
		copy: "idle",
	};
	if (recordable(review, state)) {
		return {
			...base,
			phase: {
				kind: "bringing-in",
				review,
				discard: false,
				progress: freshProgress(at),
			},
			request: { id: nextRequestId(state), sent: false },
		};
	}
	if (review.kind === "nothing") {
		return {
			...base,
			phase: { kind: "settled", review, outcome: null },
			request: answeredRequest(state),
			settled: {
				id: nextSettledId(state),
				kind: "nothing",
				deployment: null,
				publishChanges: review.publishChanges,
			},
		};
	}
	return {
		...base,
		phase: { kind: "answered", review, notice: null },
		request: answeredRequest(state),
	};
}

function withProgress(
	state: HqChangesPanelState,
	update: (progress: HqChangesProgressState) => HqChangesProgressState,
): HqChangesPanelState {
	const { phase } = state;
	if (phase.kind === "loading") {
		return { ...state, phase: { ...phase, progress: update(phase.progress) } };
	}
	if (phase.kind === "bringing-in") {
		return { ...state, phase: { ...phase, progress: update(phase.progress) } };
	}
	return state;
}

/** Whether the person can press a choice now: a review that offers one, with no request in flight. */
function choicesOpen(state: HqChangesPanelState): ChangesReview | null {
	const { phase } = state;
	return phase.kind === "answered" && phase.review.kind === "changes"
		? phase.review
		: null;
}

export function reduceHqChangesPanel(
	state: HqChangesPanelState,
	event: HqChangesPanelEvent,
): HqChangesPanelState {
	switch (event.type) {
		case "check": {
			/* A request in flight is not sent twice: Check again is drawn only
			 * where none is. */
			if (state.phase.kind === "loading" || state.phase.kind === "bringing-in")
				return state;
			return {
				...state,
				phase: { kind: "loading", progress: freshProgress(event.at) },
				request: { id: nextRequestId(state), sent: false },
				moved: null,
				needsChoice: null,
				copy: "idle",
			};
		}
		case "sent":
			return state.request.id === event.id
				? { ...state, request: { id: event.id, sent: true } }
				: state;
		case "stage":
			return withProgress(state, (progress) => ({
				...progress,
				stage: event.stage,
				files: null,
			}));
		case "files":
			return withProgress(state, (progress) => ({
				...progress,
				files: { done: event.done, total: event.total },
			}));
		case "review-answered":
			if (state.phase.kind !== "loading") return state;
			return withReview(state, event.review, state.phase.progress.startedAt);
		case "review-ended":
			if (state.phase.kind !== "loading") return state;
			return {
				...state,
				phase: { kind: "unanswered", end: event.end },
				request: answeredRequest(state),
			};
		case "bring-in-pressed": {
			const review = choicesOpen(state);
			if (review === null) return state;
			/* Use CommCare HQ's version is offered only where something in Nova
			 * would be removed and no rename holds it back; Bring in these
			 * changes only where nothing would be. */
			const removes = review.novaChanges.length > 0;
			if (event.discard !== removes) return state;
			if (removes && review.renamedInNova.length > 0) return state;
			if (unansweredTables(review, state.tableChoices)) {
				return {
					...state,
					needsChoice: { nonce: (state.needsChoice?.nonce ?? 0) + 1 },
				};
			}
			return {
				...state,
				phase: {
					kind: "bringing-in",
					review,
					discard: event.discard,
					progress: freshProgress(event.at),
				},
				request: { id: nextRequestId(state), sent: false },
				needsChoice: null,
				moved: null,
			};
		}
		case "bring-in-answered": {
			const { phase } = state;
			if (phase.kind !== "bringing-in") return state;
			const { outcome } = event;
			switch (outcome.kind) {
				case "brought-in":
					return {
						...state,
						phase: { kind: "settled", review: phase.review, outcome },
						request: answeredRequest(state),
						settled: {
							id: nextSettledId(state),
							kind: "brought-in",
							deployment: outcome.deployment,
							discarded: outcome.discarded,
						},
					};
				case "recorded":
					return {
						...state,
						phase: { kind: "settled", review: phase.review, outcome },
						request: answeredRequest(state),
						recordedDigests: withRecordAnswered(state, phase.review),
						settled: {
							id: nextSettledId(state),
							kind: "nothing",
							deployment: outcome.deployment,
							publishChanges: phase.review.publishChanges,
						},
					};
				case "changed": {
					/* A record answered with the review moved is not sent by
					 * itself again, even where the review it now names is the
					 * same: that would ask the same question forever. */
					const answeredOnce: HqChangesPanelState = {
						...state,
						recordedDigests: withRecordAnswered(state, phase.review),
					};
					return {
						...withReview(answeredOnce, outcome.now, phase.progress.startedAt),
						moved: { editedBy: outcome.editedBy },
					};
				}
				case "gate":
					return answeredAgain(state, phase.review, {
						kind: "gate",
						findings: outcome.findings,
					});
				case "refused":
					return answeredAgain(state, phase.review, {
						kind: "refused",
						message: outcome.message,
					});
				default: {
					const unplaced: never = outcome;
					return unplaced;
				}
			}
		}
		case "bring-in-ended": {
			const { phase } = state;
			if (phase.kind !== "bringing-in") return state;
			return answeredAgain(state, phase.review, {
				kind: "ended",
				end: event.end,
			});
		}
		case "table-chosen":
			if (choicesOpen(state) === null) return state;
			return {
				...state,
				tableChoices: { ...state.tableChoices, [event.tag]: event.choice },
			};
		case "show-all":
			return { ...state, shownAll: { ...state.shownAll, [event.list]: true } };
		case "copied":
			return { ...state, copy: "copied" };
		case "copy-refused":
			return { ...state, copy: "refused" };
		case "copy-cleared":
			return state.copy === "copied" ? { ...state, copy: "idle" } : state;
		default: {
			const unplaced: never = event;
			return unplaced;
		}
	}
}

/** The record digests once `review`'s record was answered. */
function withRecordAnswered(
	state: HqChangesPanelState,
	review: ReviewToBringIn,
): readonly string[] {
	if (review.kind !== "nothing") return state.recordedDigests;
	return state.recordedDigests.includes(review.reviewDigest)
		? state.recordedDigests
		: [...state.recordedDigests, review.reviewDigest];
}

/**
 * The review again, with its buttons back and the notice beside it. A
 * recorded read that ended with no answer is no choice to offer again, so
 * it ends as an unanswered review the person checks again.
 */
function answeredAgain(
	state: HqChangesPanelState,
	review: ReviewToBringIn,
	notice: BringInNotice,
): HqChangesPanelState {
	if (review.kind === "nothing") {
		return {
			...state,
			phase:
				notice.kind === "ended"
					? { kind: "unanswered", end: notice.end }
					: { kind: "answered", review, notice },
			request: answeredRequest(state),
		};
	}
	return {
		...state,
		phase: { kind: "answered", review, notice },
		request: answeredRequest(state),
	};
}

/** The request to send now, or null: each is named once, until `sent`. */
export function nextRequest(
	state: HqChangesPanelState,
): HqChangesRequest | null {
	const { request, phase } = state;
	if (request.sent) return null;
	if (phase.kind === "loading") return { id: request.id, kind: "review" };
	if (phase.kind === "bringing-in") {
		return {
			id: request.id,
			kind: "bring-in",
			readingId: phase.review.readingId,
			reviewDigest: phase.review.reviewDigest,
			tableChoices:
				phase.review.kind === "changes"
					? Object.fromEntries(
							choiceTables(phase.review).flatMap((table) => {
								const choice = state.tableChoices[table.tag];
								return choice === undefined ? [] : [[table.tag, choice]];
							}),
						)
					: {},
		};
	}
	return null;
}

// ── What the panel draws ─────────────────────────────────────────────

/** How many lines of a list show before Show all. */
export const LIST_LINES_SHOWN = 10;

export interface ListView {
	readonly shown: readonly string[];
	/** The number Show all names, or null where every line shows. */
	readonly showAll: number | null;
}

function listView(lines: readonly string[], all: boolean): ListView {
	if (all || lines.length <= LIST_LINES_SHOWN)
		return { shown: lines, showAll: null };
	return { shown: lines.slice(0, LIST_LINES_SHOWN), showAll: lines.length };
}

/** A button the panel offers, with the sentence under it. */
export interface ChoiceView {
	readonly label: string;
	readonly helper: string | null;
}

export interface ListsView {
	readonly kind: "lists";
	readonly hqHeading: string;
	readonly hqLead: string;
	readonly hqList: ListView;
	readonly caseData: readonly string[];
	readonly publishChanges: readonly string[];
	/** Nova's list, or null where nothing in Nova would be removed. */
	readonly nova: {
		readonly heading: string;
		readonly lead: string;
		readonly madeBy: readonly string[];
		readonly list: ListView;
	} | null;
	/** Copy both lists, where Nova's list is shown. */
	readonly copyBoth: boolean;
	/** The tables that ask their choice. */
	readonly tables: ChangesReview["tables"];
	readonly projectName: string;
	/**
	 * The gate's refusal, a refusal or a request that ended, beside the lists,
	 * with Check again where checking again can help and `renamed` does not
	 * already offer it.
	 */
	readonly notice: {
		readonly lines: readonly string[];
		readonly role: "alert" | "status";
		readonly checkAgain: boolean;
	} | null;
	/** The choices, or null while the bring-in runs. */
	readonly choices: {
		/** Bring in these changes, Use CommCare HQ's version, or null where `renamed` stands in its place. */
		readonly bringIn: (ChoiceView & { readonly discard: boolean }) | null;
		/** The line naming the case properties renamed in Nova, with Check again. */
		readonly renamed: string | null;
		/** Publish over CommCare HQ's changes, with `PUBLISH_OVER_INSTEAD_LINE` above it in the publish dialog where nothing in Nova would be removed. */
		readonly publishOver:
			| (ChoiceView & { readonly lead: string | null })
			| null;
		/** Stop publishing here (or the editor's line in its place). */
		readonly stop: boolean;
	} | null;
}

export type PanelBodyView =
	| { readonly kind: "loading" }
	| ListsView
	/** Nothing to bring in. `goesAhead`: the card's line once the read is recorded. */
	| {
			readonly kind: "nothing";
			readonly line: string;
			readonly publishChanges: readonly string[];
			readonly goesAhead: boolean;
	  }
	/** Something Nova can't hold. `tooLarge`: CommCare HQ's version is over the size Nova brings in, so no Check again. */
	| {
			readonly kind: "account";
			readonly heading: string;
			readonly lead: string;
			readonly account: AccountReview;
			readonly tooLarge: CircumstanceFinding | null;
			readonly otherWays: string;
	  }
	/** A stop of a CommCare HQ read: the circumstance block, with Check again. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	/**
	 * Why Nova can't bring the changes in, a change Nova can't take, a
	 * recorded read answered again, and a request that ended with no answer.
	 */
	| {
			readonly kind: "line";
			readonly line: string;
			readonly role: "alert" | "status";
			readonly checkAgain: boolean;
	  }
	/** After it is brought in. */
	| { readonly kind: "brought-in"; readonly line: string };

export interface PanelView {
	/** The stage row, while a request is on its way. */
	readonly stage: {
		readonly label: string;
		/** The label a screen reader is told, its count moved every ten files. */
		readonly announced: string;
		readonly startedAt: number;
	} | null;
	/** `hqChangesMovedLine` or `HQ_CHANGES_NOTHING_TAKEN_LINE`, above the panel in its new state. */
	readonly moved: string | null;
	readonly body: PanelBodyView;
	/**
	 * Whether the app's item in the publish dialog is drawn as it is without
	 * the panel (its parts, its Publish over this and the stop block):
	 * under an account of what Nova can't hold and under every stop, never while the panel loads or offers its own
	 * choices, since those are the item's controls.
	 */
	readonly drawsItem: boolean;
	/**
	 * On the card, where the body names publishing over and stopping
	 * publishing here as the ways on (`bodyNamesWaysOn`), the panel draws
	 * those two controls under it, since the card has no item to stand in
	 * for them.
	 */
	readonly waysOn: boolean;
}

export interface PanelViewContext {
	readonly home: HqChangesPanelHome;
	readonly domain: string;
	/**
	 * What the surface knows the change is measured against: the refused
	 * change's own in the publish dialog, the record's on the card. A review
	 * that names its own reference is read by it instead.
	 */
	readonly since: DriftReference;
	readonly dateOptions?: DriftDateOptions;
}

const ANNOUNCE_EVERY = 10;

function stageLabel(
	stage: HqChangesStage | null,
	files: FileCount | null,
): string {
	const shown = stage ?? "reading-app";
	if (shown === "checking-media")
		return HQ_CHANGES_STAGE_LABELS["checking-media"](files);
	return HQ_CHANGES_STAGE_LABELS[shown];
}

function announced(files: FileCount | null): FileCount | null {
	if (files === null || files.done === files.total) return files;
	return {
		done: files.done - (files.done % ANNOUNCE_EVERY),
		total: files.total,
	};
}

function stageView(progress: HqChangesProgressState): PanelView["stage"] {
	return {
		label: stageLabel(progress.stage, progress.files),
		announced: stageLabel(progress.stage, announced(progress.files)),
		startedAt: progress.startedAt,
	};
}

function since(reference: DriftReference, context: PanelViewContext): string {
	return sincePhrase(reference, context.domain, context.dateOptions);
}

function noticeLines(notice: BringInNotice): {
	readonly lines: readonly string[];
	readonly role: "alert" | "status";
	readonly checkAgain: boolean;
} {
	switch (notice.kind) {
		case "gate":
			return {
				lines: [HQ_CHANGES_GATE_LEAD, ...notice.findings, HQ_CHANGES_GATE_NEXT],
				role: "alert",
				checkAgain: true,
			};
		case "refused":
			return { lines: [notice.message], role: "alert", checkAgain: true };
		case "ended":
			return {
				lines: [endLine(notice.end, HQ_CHANGES_BRING_IN_LOST_LINE)],
				role: "alert",
				checkAgain: endChecksAgain(notice.end),
			};
	}
}

/** The line for a request that ended with no answer; `lostLine` is the request's own. */
function endLine(end: RequestEnd, lostLine: string): string {
	if (end === "lost") return lostLine;
	if (end === "failed") return HQ_CHANGES_FAILED_LINE;
	return end.message;
}

function endChecksAgain(end: RequestEnd): boolean {
	return typeof end === "string" ? true : end.checkAgain;
}

function listsView(
	state: HqChangesPanelState,
	review: ChangesReview,
	notice: BringInNotice | null,
	running: boolean,
	context: PanelViewContext,
): ListsView {
	const removes = review.novaChanges.length > 0;
	const renamed =
		removes && review.renamedInNova.length > 0
			? renamedInNovaLine(review.renamedInNova)
			: null;
	return {
		kind: "lists",
		hqHeading: HQ_CHANGES_HEADING,
		hqLead: hqChangesLead(since(review.since, context), removes),
		hqList: listView(review.hqChanges, state.shownAll.hq),
		caseData: review.caseData,
		publishChanges: review.publishChanges,
		nova: removes
			? {
					heading: NOVA_CHANGES_HEADING,
					lead: NOVA_CHANGES_LEAD,
					madeBy: review.madeBy,
					list: listView(review.novaChanges, state.shownAll.nova),
				}
			: null,
		copyBoth: removes,
		tables: choiceTables(review),
		projectName: review.projectName,
		notice:
			notice === null
				? null
				: (() => {
						const lines = noticeLines(notice);
						return {
							...lines,
							checkAgain: lines.checkAgain && renamed === null,
						};
					})(),
		choices: running
			? null
			: {
					bringIn:
						renamed !== null
							? null
							: removes
								? {
										label: USE_HQ_VERSION_ACTION,
										helper: USE_HQ_VERSION_HELPER,
										discard: true,
									}
								: {
										label: BRING_IN_CHANGES_ACTION,
										helper: null,
										discard: false,
									},
					renamed,
					/* Where nothing in Nova would be removed, the card offers no
					 * publish over of its own, except under the gate's refusal,
					 * whose sentence names it as the other way on. */
					publishOver:
						removes || (context.home === "card" && notice?.kind === "gate")
							? {
									label: PUBLISH_OVER_HQ_ACTION,
									helper: PUBLISH_OVER_HQ_HELPER,
									lead: null,
								}
							: context.home === "publish"
								? {
										label: PUBLISH_OVER_HQ_ACTION,
										helper: null,
										lead: PUBLISH_OVER_INSTEAD_LINE,
									}
								: null,
					stop: removes,
				},
	};
}

function nothingView(
	review: NothingReview,
	recorded: boolean,
	context: PanelViewContext,
): PanelBodyView {
	return {
		kind: "nothing",
		line: nothingToBringInLine(review.reason, since(review.since, context)),
		publishChanges: review.publishChanges,
		goesAhead: context.home === "card" && recorded,
	};
}

function answeredBody(
	state: HqChangesPanelState,
	review: HqChangesReview,
	notice: BringInNotice | null,
	context: PanelViewContext,
): PanelBodyView {
	switch (review.kind) {
		case "changes":
			return listsView(state, review, notice, false, context);
		case "nothing":
			/* Only a recorded read that took nothing is answered again: its
			 * notice says why, and Check again reads it once more. */
			if (notice === null) return nothingView(review, false, context);
			{
				const lines = noticeLines(notice);
				return {
					kind: "line",
					line: lines.lines.join(" "),
					role: "alert",
					checkAgain: lines.checkAgain,
				};
			}
		case "account": {
			const [only] = review.findings;
			const tooLarge =
				review.findings.length === 1 &&
				review.more === 0 &&
				only !== undefined &&
				only.subject === null &&
				only.code === "too-large"
					? only
					: null;
			return {
				kind: "account",
				heading: CANNOT_BRING_IN_HEADING,
				lead:
					tooLarge !== null
						? CANNOT_BRING_IN_TOO_LARGE_LEAD
						: cannotBringInLead(review.findings.length + review.more),
				account: review,
				tooLarge,
				otherWays: CANNOT_BRING_IN_OTHER_WAYS,
			};
		}
		case "held":
			return {
				kind: "line",
				line: hqChangesHeldLine(review.reason, review.runs),
				role: "status",
				checkAgain: true,
			};
		case "unavailable":
			return {
				kind: "line",
				line: hqChangesUnavailableLine(review.reason, {
					domain: context.domain,
					since: review.since ?? context.since,
					options: context.dateOptions,
				}),
				role: "status",
				checkAgain: review.reason === "nova-defect",
			};
		case "stop":
			return { kind: "stop", finding: review.finding };
		default: {
			const unplaced: never = review;
			return unplaced;
		}
	}
}

/**
 * Whether a body's own sentence names publishing over and stopping
 * publishing here as the ways on, with no control of the panel's for
 * either: an account of what Nova can't hold, a held change, and the
 * unavailable reasons `base-too-large` and `nova-defect`.
 */
function bodyNamesWaysOn(state: HqChangesPanelState): boolean {
	const { phase } = state;
	if (phase.kind !== "answered") return false;
	const { review } = phase;
	switch (review.kind) {
		case "account":
		case "held":
			return true;
		case "unavailable":
			return (
				review.reason === "base-too-large" || review.reason === "nova-defect"
			);
		default:
			return false;
	}
}

/** Whether a body is one of the panel's own choices (or the wait for them): the item stays hidden. */
function bodyHidesItem(body: PanelBodyView): boolean {
	switch (body.kind) {
		case "loading":
		case "lists":
		case "nothing":
		case "brought-in":
			return true;
		case "account":
		case "stop":
		case "line":
			return false;
	}
}

export function panelView(
	state: HqChangesPanelState,
	context: PanelViewContext,
): PanelView {
	const { phase } = state;
	let body: PanelBodyView;
	let stage: PanelView["stage"] = null;
	switch (phase.kind) {
		case "loading":
			body = { kind: "loading" };
			stage = stageView(phase.progress);
			break;
		case "unanswered":
			body = {
				kind: "line",
				line: endLine(phase.end, HQ_CHANGES_REVIEW_LOST_LINE),
				role: "alert",
				checkAgain: endChecksAgain(phase.end),
			};
			break;
		case "answered":
			body = answeredBody(state, phase.review, phase.notice, context);
			break;
		case "bringing-in":
			body =
				phase.review.kind === "changes"
					? listsView(state, phase.review, null, true, context)
					: nothingView(phase.review, false, context);
			stage = stageView(phase.progress);
			break;
		case "settled":
			body =
				phase.outcome?.kind === "brought-in"
					? { kind: "brought-in", line: broughtInLine(phase.outcome.discarded) }
					: phase.review.kind === "nothing"
						? nothingView(phase.review, true, context)
						: { kind: "brought-in", line: broughtInLine(false) };
			break;
		default: {
			const unplaced: never = phase;
			return unplaced;
		}
	}
	/* `hqChangesMovedLine` stands over a list, or over a standing with nothing to bring in;
	 * over a stop or anything Nova can't bring in, the request took nothing,
	 * and the new state says why. */
	const moved =
		state.moved === null
			? null
			: body.kind === "lists" || body.kind === "nothing"
				? hqChangesMovedLine(state.moved.editedBy)
				: HQ_CHANGES_NOTHING_TAKEN_LINE;
	return {
		stage,
		moved,
		body,
		drawsItem: !bodyHidesItem(body),
		waysOn: context.home === "card" && bodyNamesWaysOn(state),
	};
}

// ── What a choice hands the surface that holds the panel ─────────────

/**
 * The discard Publish over CommCare HQ's changes hands the publish dialog:
 * the app's change, under the digest of CommCare HQ's source the review
 * read, so a publish after CommCare HQ changed again stops and asks again.
 * Null where the panel offers no such choice now.
 */
export function publishOverDiscard(
	state: HqChangesPanelState,
	appId: string,
): RemoteChangeDiscard | null {
	const review = choicesOpen(state);
	if (review === null) return null;
	return {
		kind: "app",
		novaResourceId: appId,
		observedDigest: review.observedDigest,
	};
}

/** Every line of both lists, shown or not, under their two headings: what Copy both lists copies. */
export function bothListsText(review: ChangesReview): string {
	return [
		HQ_CHANGES_HEADING,
		...review.hqChanges,
		"",
		NOVA_CHANGES_HEADING,
		...review.novaChanges,
	].join("\n");
}

/** The review whose lists the panel shows, for Copy both lists. */
export function shownChanges(state: HqChangesPanelState): ChangesReview | null {
	const { phase } = state;
	if (
		(phase.kind === "answered" || phase.kind === "bringing-in") &&
		phase.review.kind === "changes"
	)
		return phase.review;
	return null;
}

// ── The builder's header ─────────────────────────────────────────────

/** Whether two targets are one project space. */
export function sameHqChangedTarget(
	a: HqChangedTarget,
	b: HqChangedTarget,
): boolean {
	return a.server === b.server && a.domain === b.domain;
}

/**
 * What See what changed in CommCare HQ does: nothing to show, the card's
 * dialog on the one project space that changed, or the Publishing section
 * where more than one did.
 */
export function headerChangesAction(
	targets: readonly HqChangedTarget[],
):
	| { readonly kind: "none" }
	| { readonly kind: "dialog"; readonly target: HqChangedTarget }
	| { readonly kind: "publishing" } {
	if (targets.length === 0) return { kind: "none" };
	if (targets.length === 1) return { kind: "dialog", target: targets[0] };
	return { kind: "publishing" };
}

/**
 * What the check route answered, read strictly: a body that is not
 * `{ changed: { server, domain }[] }` with each server one Nova knows is no
 * answer, and the check says nothing.
 */
export function hqChangedTargetsOf(
	body: unknown,
): readonly HqChangedTarget[] | null {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return null;
	const changed = (body as { readonly changed?: unknown }).changed;
	if (!Array.isArray(changed)) return null;
	const targets: HqChangedTarget[] = [];
	for (const entry of changed) {
		if (typeof entry !== "object" || entry === null) return null;
		const { server, domain } = entry as {
			readonly server?: unknown;
			readonly domain?: unknown;
		};
		if (typeof server !== "string" || !isDeploymentServer(server)) return null;
		if (typeof domain !== "string" || domain === "") return null;
		const target: HqChangedTarget = { server, domain };
		if (!targets.some((held) => sameHqChangedTarget(held, target)))
			targets.push(target);
	}
	return targets;
}

// ── The Publishing card ──────────────────────────────────────────────

/**
 * Whether Refresh from CommCare HQ's answer offers See what changed beside
 * its sentence: exactly where CommCare HQ saved the app since Nova last read
 * it (`changed-in-hq`), which the panel can then review.
 */
export function keptRefreshOffersReview(
	result: DeploymentActionResult<KeptRefreshView>,
): boolean {
	return result.success && result.data.kind === "changed-in-hq";
}

/**
 * What the change on a card is measured against, as far as the record says:
 * the day the app was brought in, while Nova has not published there since
 * (the record still holds the first publish's list); otherwise the last
 * publish. A review that names its own reference is read by that instead.
 */
export function cardDriftReference(view: DeploymentView): DriftReference {
	const broughtIn = broughtInOf(view);
	return broughtIn !== null && view.firstPublish?.of === "first-publish"
		? { kind: "brought-in", at: broughtIn.at }
		: { kind: "published" };
}
