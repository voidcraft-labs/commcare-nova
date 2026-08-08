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
 *      atomic `applyMany` (one history entry); one `pushEvents`
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
 * `data-run-id` and `data-app-materialized` are handled inline in
 * ChatContainer's `onData` and never reach this dispatcher.
 *
 * ## Reconciler integration
 *
 * When a reconciler is present (every live builder session), a chat
 * `data-mutations` batch is REGISTERED in the reconciler
 * (`registerChatBatch`) before it is applied to the store, so the batch's
 * own durable-stream echo is recognized + dropped and `localBase()` folds it.
 * The apply itself runs inside a REPLAY bracket (`beginRemoteApply`), which is
 * what keeps the SA's own mutations out of the author's command queue and off
 * the next PUT — the batch was already committed server-side. `data-done`
 * reseeds the reconciler's confirmed baseline from the carried `{ doc, seq }`
 * instead of `docStore.load()` (the agent suppression bracket is still open).
 * A brand-new build's reconciler is DORMANT (no app id yet): `registerChatBatch`
 * / `onDataDone` no-op, and the mutations apply directly to the store — the
 * reconciler activates on `data-app-materialized`.
 *
 * Signal grid energy is injected BEFORE processing so the animation
 * responds to event arrival, not post-mutation.
 */

import type { Reconciler } from "@/lib/collab/reconciler";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { PersistableDoc } from "@/lib/domain";
import type { ConversationEvent, MutationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { READ_ENERGY_PER_CHAR, signalGrid } from "@/lib/signalGrid/store";
import {
	showToast,
	type ToastOptions,
	type ToastSeverity,
} from "@/lib/ui/toastStore";

type StreamToastEmitter = (
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
) => string;

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
 * The ONE reader of a `data-conversation-event` envelope's error payload,
 * typed against `ConversationEvent` so the wire shape is asserted in exactly
 * one place. Both consumers ride it: this dispatcher's toast (severity from
 * `fatal`) and `ChatContainer`'s auto-resend fatal-strike counter (only a
 * fatal error counts). A silent structural cast in either would stop matching if the
 * envelope ever changed, and for the halt that failure mode is the retry
 * storm coming back with nothing failing at compile time. Returns null for
 * every non-error conversation event.
 */
export function conversationEventError(
	data: Record<string, unknown>,
): { message: string; fatal: boolean } | null {
	const event = data as unknown as ConversationEvent;
	if (event.payload?.type !== "error") return null;
	return {
		message: event.payload.error.message,
		fatal: !!event.payload.error.fatal,
	};
}

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
	projectToast?: StreamToastEmitter,
): void {
	const admittedMutations =
		type === "data-mutations" ? admitMutationBatch(data.mutations) : null;
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
	// one history entry) and the `events` envelopes (for
	// the session buffer — lifecycle derivations read the stage tags).
	if (type === "data-mutations") {
		if (admittedMutations === null) {
			throw new Error("data-mutations admission invariant failed");
		}
		const mutations = admittedMutations;
		const events = data.events as MutationEvent[] | undefined;
		const batchId = data.batchId as string | undefined;
		const seq = data.seq as number | undefined;
		if (mutations.length > 0) {
			/* Register the SA batch in the reconciler BEFORE applying it: once
			 * it's in `sentPending`, `localBase()` folds it, so the reconciler's
			 * view of the document accounts for the SA's edit instead of reading
			 * it as a peer's divergence. A dormant new-build reconciler no-ops (no
			 * app id yet); its mutations still apply directly to the store.
			 *
			 * `alreadyConfirmed` means the batch's /stream echo BEAT this chunk
			 * (two independent transports) and already folded these mutations into
			 * `displayed` — so `applyMany` here would apply them a SECOND time (the
			 * non-dedup add reducers would splice a duplicated entity). Skip it. */
			let alreadyConfirmed = false;
			if (
				reconciler &&
				!reconciler.isDormant() &&
				batchId !== undefined &&
				seq !== undefined
			) {
				({ alreadyConfirmed } = reconciler.registerChatBatch({
					batchId,
					runId,
					mutations,
					seq,
				}));
			}
			/* Apply inside a REPLAY bracket. The SA's batch was committed
			 * server-side before this frame was streamed, so it is exactly what
			 * that bracket describes — an already-persisted write arriving from
			 * the server. Without it the store queues the SA's own mutations as
			 * un-persisted author intent and the next auto-save PUTs them
			 * straight back. */
			if (!alreadyConfirmed) {
				const store = docStore.getState();
				store.beginRemoteApply();
				try {
					store.applyMany(mutations);
				} finally {
					store.endRemoteApply();
				}
			}
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
		const error = conversationEventError(data);
		if (error) {
			(projectToast ?? showToast)(
				error.fatal ? "error" : "warning",
				"Generation error",
				error.message,
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
			 *    whose `data-app-materialized` hasn't activated it yet), so it is the ONE
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

	// `data-run-id`, `data-design-session`, and `data-app-materialized` are
	// handled inline by ChatContainer's `onData` and never reach this
	// dispatcher. Any other type — including the design-build progress
	// frames — is ignored here.
}
