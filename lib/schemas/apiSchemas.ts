import { z } from "zod";
import { appBlueprintSchema } from "./blueprint";

/** Anthropic prompt cache TTL — 5 minutes. Used to decide whether the SA's
 *  prior conversation context is still cached or if a fresh edit session
 *  (with injected blueprint summary) would be cheaper. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

export const chatRequestSchema = z.object({
	blueprint: appBlueprintSchema.optional(),
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
