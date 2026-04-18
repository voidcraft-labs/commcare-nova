/**
 * Event log replay.
 *
 * `replayEvents` is the ~30-line dispatcher from spec §5: walk events in
 * order, call the appropriate callback, sleep between events for visual
 * pacing, and short-circuit on an abort signal.
 *
 * `deriveReplayChapters` is the chapter-metadata helper the ReplayController
 * uses to render its chapter navigation. Chapters are derived from:
 *   - a leading "Conversation" chapter (if events begin with chat-only
 *     events before any mutations)
 *   - one chapter per contiguous run of mutation events sharing the same
 *     `stage` tag (header/subtitle derived from the tag)
 *   - a synthetic "Done" chapter at the end
 *
 * The chapter start/end indices reference `events[]` directly; clicking a
 * chapter replays events[0..endIndex].
 */
import type { Mutation } from "@/lib/doc/types";
import type { ConversationPayload, Event } from "./types";

/** Sleep helper — fraction of a ms ok for fast tests. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk a log in chronological order, dispatching each event to the
 * appropriate callback. `delayPerEvent` controls visual pacing during
 * live replay; tests pass 0.
 *
 * `signal` (e.g. from an abort controller in the ReplayController) halts
 * the loop mid-iteration.
 */
export async function replayEvents(
	events: readonly Event[],
	onMutation: (m: Mutation) => void,
	onConversation: (p: ConversationPayload) => void,
	delayPerEvent = 150,
	signal?: AbortSignal,
): Promise<void> {
	for (const e of events) {
		if (signal?.aborted) return;
		if (e.kind === "mutation") onMutation(e.mutation);
		else onConversation(e.payload);
		if (delayPerEvent > 0) await sleep(delayPerEvent);
	}
}

// ── Chapter derivation ──────────────────────────────────────────────

/**
 * Chapter metadata for the ReplayController's transport UI.
 *
 * `startIndex` / `endIndex` bracket a span of `events[]`. Clicking the
 * chapter replays from `events[0]` through `events[endIndex]` — chapters
 * are cumulative scrub points, not independent segments.
 */
export interface ReplayChapter {
	header: string;
	subtitle?: string;
	startIndex: number;
	endIndex: number;
}

/** Map a `stage` tag on a MutationEvent to a chapter header. */
function headerForStage(stage: string | undefined): string {
	if (!stage) return "Update";
	if (stage === "schema") return "Data Model";
	if (stage === "scaffold") return "Scaffold";
	if (stage.startsWith("module:")) return "Module";
	if (stage.startsWith("form:")) return "Form";
	if (stage.startsWith("fix")) return "Validation Fix";
	if (stage.startsWith("rename")) return "Edit";
	if (stage.startsWith("edit")) return "Edit";
	return "Update";
}

/** Map a `stage` tag onto a display subtitle (indexed references surface here). */
function subtitleForStage(stage: string | undefined): string | undefined {
	if (!stage) return undefined;
	if (stage.startsWith("module:") || stage.startsWith("form:")) return stage;
	return undefined;
}

export function deriveReplayChapters(
	events: readonly Event[],
): ReplayChapter[] {
	const chapters: ReplayChapter[] = [];

	let cursor = 0;

	/* Leading "Conversation" chapter — the span of events before the first
	 * mutation, if any. Represents the initial chat exchange (user
	 * message + assistant preamble) before the SA starts building. */
	let firstMutationIdx = events.findIndex((e) => e.kind === "mutation");
	if (firstMutationIdx === -1) firstMutationIdx = events.length;
	if (firstMutationIdx > 0) {
		chapters.push({
			header: "Conversation",
			startIndex: 0,
			endIndex: firstMutationIdx - 1,
		});
		cursor = firstMutationIdx;
	}

	/* Now walk mutation events, grouping contiguous runs with the same
	 * `stage` tag. Intervening conversation events are absorbed into the
	 * current chapter — they ride alongside the mutations that produced
	 * them. A chapter ends when the `stage` tag changes. */
	while (cursor < events.length) {
		const e = events[cursor];
		if (e.kind !== "mutation") {
			cursor++;
			continue;
		}
		const stage = e.stage;
		const start = cursor;
		let end = cursor;
		while (end + 1 < events.length) {
			const next = events[end + 1];
			if (next.kind === "mutation" && next.stage !== stage) break;
			end++;
		}
		const subtitle = subtitleForStage(stage);
		chapters.push({
			header: headerForStage(stage),
			...(subtitle && { subtitle }),
			startIndex: start,
			endIndex: end,
		});
		cursor = end + 1;
	}

	/* Synthetic trailing "Done" chapter so the ReplayController has a
	 * terminal scrub target. Re-uses the final event's index so
	 * replaying to the Done chapter still dispatches every event. */
	const lastIdx = events.length - 1;
	if (lastIdx >= 0) {
		chapters.push({
			header: "Done",
			startIndex: lastIdx,
			endIndex: lastIdx,
		});
	}

	return chapters;
}
