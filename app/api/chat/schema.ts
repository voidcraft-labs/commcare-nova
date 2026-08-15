import { z } from "zod";

/**
 * Opaque chat-thread attribution accepted at the HTTP trust boundary. New ids
 * are UUIDs, but older/raw clients were historically allowed to supply text,
 * so compatibility requires an opaque bounded value rather than a UUID
 * assertion. It is never holder authority; `holderNonce` is the separate,
 * server-minted per-claim capability.
 */
export const chatRunIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value.trim().length > 0);

/** Server-minted per-claim holder generation echoed only by continuations. */
export const chatHolderNonceSchema = z.string().uuid();

/**
 * Wire shape of the chat endpoint's request body.
 *
 * The client sends only ids + signals: never the blueprint. The route LOADS
 * the persisted blueprint server-side off the same authorization read that
 * gates the request, so a per-turn whole-doc upload never crosses the wire.
 * A brand-new build sends no `appId`, carries the Project captured by its RSC
 * render as `expectedProjectId`, and the route seeds the SA from the exact
 * canonical sequence-1 blueprint returned by app genesis.
 *
 * `messages` is the FULL conversation history of the thread, hydrated from
 * the `threads` row on page load, extended client-side as the session runs.
 * There is no cache-window trim: resuming a conversation means the SA
 * receives that conversation.
 */
export const chatRequestSchema = z.object({
	/** The conversation this turn belongs to: client-minted uuid, one per
	 *  thread. The route persists the incoming history onto this row and
	 *  appends the assistant response at finalize. OPTIONAL by design: a
	 *  turn without one (a tab loaded before threads shipped, a raw API
	 *  caller) starts a fresh server-minted thread rather than 400ing:
	 *  the conversation still persists, it just isn't continuing one. */
	threadId: z.string().min(1).max(128).optional(),
	runId: chatRunIdSchema.optional(),
	/** Exact holder generation returned by Nova. A chargeable instruction never
	 * trusts this value and receives a newly minted nonce; a free askQuestions
	 * continuation must echo it so a stale same-thread tab cannot resume a
	 * successor claim. */
	holderNonce: chatHolderNonceSchema.optional(),
	/** App ID: present after first save so subsequent saves update the same doc.
	 * `min(1)` is load-bearing: PRESENCE of this field is what classifies the
	 * request as an existing-app turn (the credit pre-flight's floor and the
	 * admission branch both key on it), so an empty string must be a parse
	 * error rather than a value the two checks read differently. */
	appId: z.string().min(1).optional(),
	/** Design-session ID: the pre-app build scope this turn continues (an
	 *  answered question round, a recoverable failed design's re-drive, or a
	 *  resume from Designs in progress). A fresh build sends neither this nor
	 *  `appId` — the route creates and claims a new session. Never sent
	 *  beside `appId`; a materialized session's turns address the app. */
	designSessionId: z.string().uuid().optional(),
	/** Project captured by the server-rendered `/build/new` page. New-app
	 *  creation targets this exact Project after a fresh server-side edit gate;
	 *  it never re-resolves the session's mutable active Project mid-request. */
	expectedProjectId: z
		.string()
		.min(1)
		.max(255)
		.refine((value) => value.trim().length > 0)
		.optional(),
	/** The client's own read of "the app has completed initial generation"
	 *  (builder phase Ready or Completed). ADVISORY ONLY: the route derives the
	 *  authoritative build-vs-edit mode from the app row's status (only
	 *  `complete` is edit-shaped) and uses this field solely for a disagreement
	 *  warn — nothing else reads it (the credit pre-flight keys on `appId`
	 *  presence, deliberately never on a client-claimed mode). It stays on the
	 *  wire so the server can see when a client's phase read has drifted. */
	appReady: z.boolean().optional(),
	/** True on an exact-turn re-drive: either the loader found a dead live-stream
	 *  marker or the user explicitly resumed a sealed recoverable reviewed
	 *  build. It is always a fresh chargeable claim even when the frozen
	 *  transcript ends in an assistant question round. On a CLAIM CONFLICT the
	 *  request bails with a clean close instead of serialize-waiting: another
	 *  session already owns the same recovery, and queueing would duplicate it. */
	redrive: z.boolean().optional(),
});
