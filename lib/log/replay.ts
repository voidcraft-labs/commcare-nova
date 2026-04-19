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
 *
 * The chapter start/end indices reference `events[]` directly; clicking a
 * chapter replays events[0..endIndex]. The final real chapter IS the
 * terminal scrub target — there is no synthetic "Done" chapter (a prior
 * version had one, but it overlapped the previous chapter at the final
 * event index, causing `findIndex` to return the previous chapter for the
 * done cursor and show `N-1/N` instead of `N/N`).
 */
import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { ConversationPayload, Event } from "./types";

/**
 * Signal-aware sleep — resolves early when `signal` aborts so the replay
 * loop halts within one microtask of abort instead of letting the current
 * pacing delay run to completion (which would fire one extra event at the
 * top of the next iteration before the abort check caught it).
 *
 * Resolves (not rejects) on abort — callers rely on the outer loop's
 * `signal?.aborted` check to decide what to do next, keeping the two
 * abort-handling paths in one place.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Walk a log in chronological order, dispatching each event to the
 * appropriate callback with visual pacing between events. Intended for
 * live-playback consumers that want the user to see mutations land one
 * at a time (e.g. a future "watch build unfold" demo mode).
 *
 * `signal` (e.g. from an abort controller) halts the loop mid-iteration.
 * Two guards together — the top-of-loop `signal?.aborted` check and the
 * signal-aware `sleep()` — ensure abort halts within one microtask,
 * never after an extra event.
 *
 * Callbacks are invoked synchronously; returned promises are NOT awaited.
 * Keep `onMutation` / `onConversation` synchronous — the loop's pacing
 * assumes in-order synchronous dispatch.
 *
 * NOTE — scrub/hydrate paths should use `replayEventsSync` instead. The
 * sync helper makes the "no await" contract explicit so a future
 * refactor to this function (e.g. adding a microtask yield) can't
 * silently break the cursor-commit ordering in the ReplayController.
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
		if (delayPerEvent > 0) await sleep(delayPerEvent, signal);
	}
}

/**
 * Synchronous event dispatch — no promise, no sleep, no abort signal.
 *
 * Used by hydration + scrub paths where the caller needs the guarantee
 * that every mutation has landed before the next line of code runs. The
 * ReplayController commits `setReplayCursor(chapter.endIndex)`
 * immediately after this returns; if the dispatch were async, the
 * cursor would advance before the doc store caught up and
 * `useReplayMessages` would render a frame with a mismatched chat view.
 *
 * Keep the body tight — it's the entire contract. Any need for pacing,
 * batching, or abort belongs in `replayEvents` (the async variant), not
 * here. Callbacks are invoked synchronously in order.
 */
export function replayEventsSync(
	events: readonly Event[],
	onMutation: (m: Mutation) => void,
	onConversation: (p: ConversationPayload) => void,
): void {
	for (const e of events) {
		if (e.kind === "mutation") onMutation(e.mutation);
		else onConversation(e.payload);
	}
}

// ── Chapter derivation ──────────────────────────────────────────────

/**
 * Chapter metadata for the ReplayController's transport UI.
 *
 * `startIndex` / `endIndex` bracket a span of `events[]`. Clicking the
 * chapter replays from `events[0]` through `events[endIndex]` — chapters
 * are cumulative scrub points, not independent segments. The final real
 * chapter doubles as the terminal scrub target (no synthetic "Done").
 */
export interface ReplayChapter {
	header: string;
	subtitle?: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Map a `stage` tag on a MutationEvent to a chapter header.
 *
 * The SA emits compound stage tags like "fix:attempt-1",
 * "rename:0-2", "edit:0-3" — so this uses `startsWith` to collapse
 * each family onto one header. Exact `"schema"` / `"scaffold"`
 * comparisons cover the schema + scaffold phases which are not
 * compound. If a future stage name accidentally collides (e.g.
 * "fixture") the prefix match will over-group — audit stage tags
 * when adding new phases.
 */
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

/**
 * Empty BlueprintDoc seed — mirrors the chat route's initial `sessionDoc`
 * shape. The running doc used for subtitle resolution starts here and is
 * advanced chapter-by-chapter as we walk the event stream, so a `module:1`
 * chapter whose scaffold was minted several chapters earlier can still
 * resolve its index to the real module name.
 *
 * Inlined (not extracted) because this is the only consumer in this file
 * and the shape is small + stable — hoisting it into a shared helper
 * would trade minor deduplication (`resetBuilder.ts` has a near-identical
 * constant) for a cross-layer coupling that would force `lib/log` to
 * depend on `lib/services`.
 */
function emptyBlueprintDoc(): BlueprintDoc {
	return {
		appId: "",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * Map a `stage` tag onto a user-facing subtitle, resolving indexed
 * references (`module:N`, `form:M-F`) against a running BlueprintDoc
 * snapshot so the UI shows the module's / form's display name rather
 * than the SA's raw index-based tag.
 *
 * Called with the doc state that reflects every mutation from PREVIOUS
 * chapters but none from the current chapter — the scaffold establishing
 * the module/form landed earlier, so the name is already in place by the
 * time a `module:N` / `form:M-F` chapter starts.
 *
 * Falls back to the raw tag (`Module N`, `Form M-F`) when the index
 * can't be resolved — a migrated legacy log might carry a stage tag
 * that points at an entity the running doc never minted (e.g. a
 * `data-module-done` whose matching `data-scaffold` was dropped). A
 * degraded subtitle is better than a thrown error mid-render.
 */
function subtitleForStage(
	stage: string | undefined,
	doc: BlueprintDoc,
): string | undefined {
	if (!stage) return undefined;
	if (stage.startsWith("module:")) {
		const n = Number.parseInt(stage.slice("module:".length), 10);
		if (!Number.isFinite(n)) return stage;
		const uuid = doc.moduleOrder[n];
		return uuid ? (doc.modules[uuid]?.name ?? `Module ${n}`) : `Module ${n}`;
	}
	if (stage.startsWith("form:")) {
		const [mRaw, fRaw] = stage.slice("form:".length).split("-");
		const m = Number.parseInt(mRaw ?? "", 10);
		const f = Number.parseInt(fRaw ?? "", 10);
		if (!Number.isFinite(m) || !Number.isFinite(f)) return stage;
		const moduleUuid = doc.moduleOrder[m];
		const formUuid = moduleUuid ? doc.formOrder[moduleUuid]?.[f] : undefined;
		return formUuid
			? (doc.forms[formUuid]?.name ?? `Form ${m}-${f}`)
			: `Form ${m}-${f}`;
	}
	return undefined;
}

export function deriveReplayChapters(
	events: readonly Event[],
): ReplayChapter[] {
	const chapters: ReplayChapter[] = [];

	let cursor = 0;
	/* Running doc — advanced chapter-by-chapter so subtitle resolution
	 * below sees exactly the state the live SA would have observed at
	 * the start of each chapter. Uses the same `produce` + `applyMutations`
	 * pipeline as `scripts/migrate-logs-to-events.ts` so the two code paths
	 * stay in agreement on mutation semantics. */
	let doc = emptyBlueprintDoc();

	/* Leading "Conversation" chapter — the span of events before the first
	 * mutation, if any. Represents the initial chat exchange (user
	 * message + assistant preamble) before the SA starts building. No
	 * mutations to apply yet, so the running doc stays empty. */
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

		/* Resolve the subtitle BEFORE applying this chapter's mutations —
		 * the scaffold that minted the referenced module/form landed in a
		 * prior chapter and is already in `doc`. Applying the current
		 * chapter's mutations first would let a `module:N` chapter resolve
		 * against a doc where the Nth module has been updated mid-chapter,
		 * reporting a stale-then-new name on each scrub. */
		const subtitle = subtitleForStage(stage, doc);

		/* Advance through every consecutive mutation sharing this stage,
		 * applying each to the running doc so the next chapter's subtitle
		 * resolution sees final post-chapter state. Conversation events in
		 * the middle are absorbed (no mutation to apply) but still extend
		 * the chapter's end index. */
		const chapterMutations: Mutation[] = [];
		let end = cursor;
		chapterMutations.push(e.mutation);
		while (end + 1 < events.length) {
			const next = events[end + 1];
			if (next.kind === "mutation" && next.stage !== stage) break;
			if (next.kind === "mutation") chapterMutations.push(next.mutation);
			end++;
		}
		doc = produce(doc, (draft) => {
			applyMutations(draft, chapterMutations);
		});

		chapters.push({
			header: headerForStage(stage),
			...(subtitle && { subtitle }),
			startIndex: start,
			endIndex: end,
		});
		cursor = end + 1;
	}

	return chapters;
}
