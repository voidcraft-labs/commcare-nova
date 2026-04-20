import { z } from "zod";
import { blueprintDocSchema } from "@/lib/domain";

/** Anthropic prompt cache TTL — 5 minutes. Used to decide whether the SA's
 *  prior conversation context is still cached or if a fresh edit session
 *  (with injected blueprint summary) would be cheaper. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Wire shape of the chat endpoint's request body.
 *
 * The client sends the normalized `BlueprintDoc` — the domain shape
 * held by the doc store. The SA operates on `BlueprintDoc` directly;
 * conversion to the legacy nested shape happens only at genuine
 * external boundaries (XForm compiler, HQ upload). `doc` is optional
 * because brand-new builds send an empty request and the SA generates
 * the blueprint from scratch.
 */
export const chatRequestSchema = z.object({
	doc: blueprintDocSchema.optional(),
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
