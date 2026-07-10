import { z } from "zod";

/** OpenAI prompt cache TTL — 30 minutes (the fixed retention floor for the
 *  GPT-5.6 family; OpenAI may keep a prefix longer, but 30 min is what's
 *  guaranteed). Used to decide whether the SA's prior conversation context is
 *  still cached or if a fresh edit session (with injected blueprint summary)
 *  would be cheaper. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Wire shape of the chat endpoint's request body.
 *
 * The client sends only the `appId` (plus run/cache signals) — never the
 * blueprint. The route LOADS the persisted blueprint server-side off the same
 * authorization read that gates the request, so a per-turn whole-doc upload
 * never crosses the wire. A brand-new build sends no `appId` and the route
 * seeds the SA from an empty doc.
 */
export const chatRequestSchema = z.object({
	runId: z.string().optional(),
	/** Firestore app ID — present after first save so subsequent saves update the same doc. */
	appId: z.string().optional(),
	/** ISO timestamp of the last SA response in this session. Used with CACHE_TTL_MS
	 *  to determine whether the conversation is within the prompt cache window. */
	lastResponseAt: z.string().optional(),
	/** True when the app has completed initial generation (builder phase is Ready
	 *  or Completed). Prevents fresh-edit mode from activating mid-generation
	 *  when modules exist but the build isn't finished yet. */
	appReady: z.boolean().optional(),
});
