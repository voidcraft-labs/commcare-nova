/**
 * Stream event dispatcher — routes server-sent generation events to the
 * session events buffer, the doc store, and the signal grid.
 *
 * Every event the server sends over SSE during a run falls into one of
 * three categories (checked in this order):
 *
 *   1. **Doc mutation batch** — `data-mutations`. Carries a raw
 *      `Mutation[]` for `docStore.applyMany` AND the corresponding
 *      `MutationEvent[]` envelopes for the session events buffer. One
 *      atomic `applyMany` (zundo-grouped undo entry); one `pushEvents`
 *      append (lifecycle derivation sees the stage tags).
 *
 *   2. **Conversation event** — `data-conversation-event`. Carries a
 *      full `ConversationEvent` envelope (user / assistant text / tool
 *      call+result / error / attachment-prep). Pushed onto the buffer
 *      verbatim. `error` payloads also trigger a toast — the signal
 *      panel will reflect the same info via the derived `agentError`,
 *      but a toast is the right UX for a stream-level failure.
 *
 *   3. **Whole-build completion** — `data-done`. Reseeds the reconciler's
 *      confirmed baseline from the final snapshot the route's drain-end
 *      finalize ships AND stamps `runCompletedAt` (the celebration signal).
 *      Stream-close lifecycle is owned by ChatContainer's chat-status
 *      effect via `endRun` — separate concern.
 *
 * `data-run-id` and `data-app-id` are handled inline in
 * ChatContainer's `onData` and never reach this dispatcher.
 *
 * ## Reconciler integration
 *
 * When a reconciler is present (every live builder session), a chat
 * `data-mutations` batch is REGISTERED in the reconciler
 * (`registerChatBatch`) before it is applied to the store, so the batch's
 * own durable-stream echo is recognized + dropped and `useAutoSave` doesn't
 * re-PUT the SA's own edit (it is already in `localBase()`). `data-done`
 * reseeds the reconciler's confirmed baseline from the carried `{ doc, seq }`
 * instead of `docStore.load()` (the agent suppression bracket is still open).
 * A brand-new build's reconciler is DORMANT (no app id yet): `registerChatBatch`
 * / `onDataDone` no-op, and the mutations apply directly to the store — the
 * reconciler activates on `data-app-id`.
 *
 * Signal grid energy is injected BEFORE processing so the animation
 * responds to event arrival, not post-mutation.
 */

import type { Reconciler } from "@/lib/collab/reconciler";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import type { ConversationEvent, MutationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { READ_ENERGY_PER_CHAR, signalGrid } from "@/lib/signalGrid/store";
import { showToast } from "@/lib/ui/toastStore";

// ── Signal grid energy table ────────────────────────────────────────────

/**
 * Inject energy into the signal grid based on event significance.
 *
 * High-energy (200) = doc mutation batch landed (the main visual pulse).
 * Medium (100) = full-doc edit replacement. Low (50) = conversation
 * activity (assistant chatter, tool calls, error annotations).
 */
function injectSignalEnergy(type: string): void {
	switch (type) {
		case "data-mutations":
			signalGrid.injectEnergy(200);
			break;
		case "data-conversation-event":
			signalGrid.injectEnergy(50);
			break;
	}
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Dispatch a single server-sent stream event to the appropriate handlers.
 *
 * @param type         - stream event type (e.g. "data-mutations")
 * @param data         - event payload — shape varies by event type
 * @param docStore     - the BlueprintDoc Zustand store
 * @param sessionStore - the BuilderSession Zustand store
 * @param reconciler   - the session reconciler (null in replay); a chat batch
 *                       registers in it and `data-done` reseeds it
 * @param runId        - the active run id (from `data-run-id`) — the reconciler
 *                       records it on the chat batch so its own echo is matched
 */
export function applyStreamEvent(
	type: string,
	data: Record<string, unknown>,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
	reconciler: Reconciler | null,
	runId: string | undefined,
): void {
	injectSignalEnergy(type);

	// ── Document-read progress (ephemeral) ───────────────────────────
	//
	// The send-time backstop streams its extraction; each `data-extract-progress`
	// carries the output char delta. Map it to think energy so the grid pulses with
	// real read progress during "Reading your documents", same feed the composer's
	// eager read uses. Transient — no buffer/store state, energy only.
	if (type === "data-extract-progress") {
		const delta = typeof data.delta === "number" ? data.delta : 0;
		if (delta > 0) signalGrid.injectThinkEnergy(delta * READ_ENERGY_PER_CHAR);
		return;
	}

	// ── Doc mutation batch ───────────────────────────────────────────
	//
	// Payload now carries both the raw `mutations` (for `applyMany` — one
	// atomic zundo-grouped undo entry) and the `events` envelopes (for
	// the session buffer — lifecycle derivations read the stage tags).
	if (type === "data-mutations") {
		const mutations = data.mutations as Mutation[] | undefined;
		const events = data.events as MutationEvent[] | undefined;
		const batchId = data.batchId as string | undefined;
		const seq = data.seq as number | undefined;
		if (mutations && mutations.length > 0) {
			/* Register the SA batch in the reconciler BEFORE applying it: once
			 * it's in `sentPending`, `localBase()` folds it, so the store
			 * subscriber that fires synchronously from `applyMany` sees an empty
			 * `humanUncommitted` delta and doesn't re-PUT the SA's own edit. A
			 * dormant new-build reconciler no-ops (no app id yet); its mutations
			 * still apply directly to the store. */
			if (
				reconciler &&
				!reconciler.isDormant() &&
				batchId !== undefined &&
				seq !== undefined
			) {
				reconciler.registerChatBatch({ batchId, runId, mutations, seq });
			}
			docStore.getState().applyMany(mutations);
		}
		if (events && events.length > 0) {
			sessionStore.getState().pushEvents(events);
		}
		return;
	}

	// ── Conversation event ───────────────────────────────────────────
	//
	// Full envelope from the server-side `emitConversation`. Push onto
	// the buffer verbatim; error payloads also trigger a toast (the
	// signal panel reflects the same info via derived `agentError`).
	if (type === "data-conversation-event") {
		const event = data as unknown as ConversationEvent;
		sessionStore.getState().pushEvent(event);
		if (event.payload.type === "error") {
			showToast(
				event.payload.error.fatal ? "error" : "warning",
				"Generation error",
				event.payload.error.message,
			);
		}
		return;
	}

	// ── Doc lifecycle (full-doc replacements) ────────────────────────
	switch (type) {
		case "data-done": {
			/*
			 * Whole-build completion — the route's drain-end finalize
			 * finished a build run. Two side-effects:
			 *
			 * 1. Reseed the reconciler's confirmed baseline from the run's
			 *    final persisted snapshot + committed seq. Streaming may leave
			 *    the doc slightly diverged from the server's canonical result;
			 *    `onDataDone` reseeds `confirmedDoc`/`baseSeq` via a suppressed
			 *    `commitDoc` (NOT `load()`, which would trip the open-bracket
			 *    assert — the agent suppression bracket is still open, closing
			 *    only on stream-close via `endRun`). `onDataDone` is
			 *    bracket-safe even for a still-dormant reconciler (a new build
			 *    whose `data-app-id` hasn't activated it yet), so it is the ONE
			 *    reconcile path — a `load()` fallback would crash on the open
			 *    bracket. A null reconciler (replay) never emits `data-done`.
			 *
			 * 2. Stamp `runCompletedAt` — this, not stream-close, is the
			 *    "a full build just finished" signal that drives the
			 *    Completed celebration phase. askQuestions runs,
			 *    clarifying-text runs, and edit runs never emit
			 *    `data-done`, so they close silently back to Idle / Ready
			 *    without celebration.
			 *
			 * Stream-close is owned by ChatContainer's chat-status effect
			 * via `endRun()` (which clears the events buffer). These two
			 * concerns are orthogonal.
			 */
			const doc = data.doc as PersistableDoc | undefined;
			const seq = data.seq as number | undefined;
			if (doc) {
				if (reconciler) {
					// `onDataDone` is bracket-safe even when the reconciler is still
					// dormant (it reseeds via a suppressed `commitDoc`, never `load()`).
					reconciler.onDataDone({ doc, seq: seq ?? 0 });
				} else {
					// No reconciler (replay only) — replay never emits `data-done`, but
					// keep the `load()` path for that theoretical case. Replay mounts
					// no agent bracket, so `load()` is safe there.
					docStore.getState().load(doc);
				}
			}
			sessionStore.getState().markRunCompleted();
			return;
		}
	}

	// `data-run-id` and `data-app-id` are handled inline by
	// ChatContainer's `onData` and never reach this dispatcher. Any other
	// type is ignored.
}
