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
 *      call+result / error / validation-attempt). Pushed onto the buffer
 *      verbatim. `error` payloads also trigger a toast — the signal
 *      panel will reflect the same info via the derived `agentError`,
 *      but a toast is the right UX for a stream-level failure.
 *
 *   3. **Doc lifecycle** — `data-done` (final reconciled doc from
 *      `validateApp`), `data-blueprint-updated` (post-build-edit
 *      replacement). Both replace the entire doc via `docStore.load()`.
 *      Run termination is owned by ChatContainer's chat-status effect;
 *      this handler does NOT call `endRun` — emitting from here would
 *      race with the effect and double-stamp `runCompletedAt`.
 *
 * `data-run-id` and `data-app-saved` are handled inline in
 * ChatContainer's `onData` and never reach this dispatcher.
 *
 * Signal grid energy is injected BEFORE processing so the animation
 * responds to event arrival, not post-mutation.
 */

import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import type { ConversationEvent, MutationEvent } from "@/lib/log/types";
import { showToast } from "@/lib/services/toastStore";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { signalGrid } from "@/lib/signalGrid/store";

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
		case "data-blueprint-updated":
			signalGrid.injectEnergy(100);
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
 */
export function applyStreamEvent(
	type: string,
	data: Record<string, unknown>,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): void {
	injectSignalEnergy(type);

	// ── Doc mutation batch ───────────────────────────────────────────
	//
	// Payload now carries both the raw `mutations` (for `applyMany` — one
	// atomic zundo-grouped undo entry) and the `events` envelopes (for
	// the session buffer — lifecycle derivations read the stage tags).
	if (type === "data-mutations") {
		const mutations = data.mutations as Mutation[] | undefined;
		const events = data.events as MutationEvent[] | undefined;
		if (mutations && mutations.length > 0) {
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
			 * Generation complete. Reconcile the doc against the final
			 * authoritative snapshot from the SA — streaming may leave the
			 * doc slightly diverged from the server's canonical result
			 * (e.g. silent fix-loop mutations that never surfaced as
			 * incremental events). `load()` replaces the entire doc and
			 * clears + pauses undo history.
			 *
			 * Run termination is NOT signaled here. ChatContainer's
			 * chat-status effect owns the `beginRun` / `endRun` transition
			 * — driven by the AI SDK's `status` state machine which
			 * already transitions `streaming` → `ready` when the stream
			 * closes. Double-stamping `runCompletedAt` from both sides
			 * would race.
			 */
			const doc = data.doc as PersistableDoc | undefined;
			if (doc) {
				docStore.getState().load(doc);
			}
			return;
		}
		case "data-blueprint-updated": {
			/*
			 * Full doc replacement from a post-build edit tool. `load()`
			 * replaces the doc and pauses undo; we resume tracking
			 * directly on the doc store — the edit should be undoable.
			 * No session-lifecycle side effects here — the chat status
			 * effect owns `beginRun` / `endRun`.
			 */
			const doc = data.doc as PersistableDoc | undefined;
			if (doc) {
				docStore.getState().load(doc);
				docStore.getState().endAgentWrite();
			}
			return;
		}
	}

	// `data-run-id` and `data-app-saved` are handled inline by
	// ChatContainer's `onData` and never reach this dispatcher. Any other
	// type is ignored.
}
