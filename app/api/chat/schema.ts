import { z } from "zod";

/**
 * Wire shape of the chat endpoint's request body.
 *
 * The client sends only ids + signals — never the blueprint. The route LOADS
 * the persisted blueprint server-side off the same authorization read that
 * gates the request, so a per-turn whole-doc upload never crosses the wire.
 * A brand-new build sends no `appId` and the route seeds the SA from an
 * empty doc.
 *
 * `messages` is the FULL conversation history of the thread — hydrated from
 * the `threads` row on page load, extended client-side as the session runs.
 * There is no cache-window trim: resuming a conversation means the SA
 * receives that conversation.
 */
export const chatRequestSchema = z.object({
	/** The conversation this turn belongs to — client-minted uuid, one per
	 *  thread. The route persists the incoming history onto this row and
	 *  appends the assistant response at finalize. */
	threadId: z.string().min(1).max(128),
	runId: z.string().optional(),
	/** App ID — present after first save so subsequent saves update the same doc. */
	appId: z.string().optional(),
	/** True when the app has completed initial generation (builder phase is Ready
	 *  or Completed). Prevents fresh-edit mode from activating mid-generation
	 *  when modules exist but the build isn't finished yet. */
	appReady: z.boolean().optional(),
});
