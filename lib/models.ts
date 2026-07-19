/**
 * Central model configuration.
 *
 * Every LLM call goes straight to OpenAI through `@ai-sdk/openai` (the
 * Responses API) with the ONE server credential, `OPENAI_API_KEY`. Model ids
 * are OpenAI's own (e.g. "gpt-5.6-sol"); swapping a constant here switches
 * the model on every surface that uses it.
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

/**
 * Reasoning effort levels for OpenAI reasoning models (GPT-5.6 family) —
 * exactly the values the API accepts for these models (verified against the
 * wire's own error enumeration; there is no `max` tier here). `xhigh` is the
 * quality-first ceiling.
 */
export type ReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

/** Fallback model for GenerationContext methods when no model is specified. */
export const MODEL_DEFAULT = "gpt-5.6-sol";

/**
 * The `openai` provider options EVERY Nova LLM call carries. `store: false`
 * runs the Responses API stateless: OpenAI persists no response object, and
 * user content stays out of the dashboard's stored-response surfaces (API
 * traffic is excluded from model training by OpenAI's API terms — there is
 * no per-call flag to set for that). For reasoning models the SDK reacts to
 * `store: false` by auto-including `reasoning.encrypted_content`, so
 * reasoning items come back encrypted and replay across steps and turns as
 * self-contained items — the exact shape `lib/chat/sanitizeReasoningParts`
 * maintains in thread history.
 */
export const OPENAI_BASE_OPTIONS = {
	store: false,
} as const satisfies OpenAIResponsesProviderOptions;

/**
 * The ONE provider-options literal every reasoning call carries. Call this
 * instead of restating the shape: a copy that drifts (say, drops
 * `reasoningSummary`) silently darkens that surface's live-thinking feed
 * with no error anywhere.
 *
 * `reasoningSummary: 'auto'` is required for human-readable reasoning
 * summaries to stream back as `reasoning-delta` parts; without it the
 * reasoning phase is silent and nothing feeds the live-progress surfaces.
 *
 * `cache` (optional) activates GPT-5.6's documented prompt-cache
 * configuration as ONE unit — `promptCacheKey` (cache-routing affinity; the
 * SA passes one key per app) together with `promptCacheOptions
 * { mode: 'implicit', ttl: '30m' }` (contractual 30-minute lifetime;
 * implicit keeps the automatic breakpoint on the latest message that lets
 * each tool-loop step cache-read the previous step's suffix, and honors the
 * explicit stable-boundary marker `markStablePrefixBoundary` places). The
 * provider doc specifies key + options + marker as one configuration —
 * never wire a subset: key-without-marker and marker-without-key were both
 * live-measured to read zero across requests. One-shot calls (extraction,
 * scripts) pass no cache config.
 */
export function reasoningProviderOptions(
	effort: ReasoningEffort,
	cache?: { promptCacheKey: string },
) {
	// `satisfies` (not an annotation) so the literal's own type flows into
	// providerOptions' JSONObject requirement, while a misplaced or
	// misspelled key is still rejected — the AI SDK's Zod schema silently
	// strips unknown fields, so an unchecked typo would appear to work and
	// never reach the wire.
	return {
		openai: {
			...OPENAI_BASE_OPTIONS,
			reasoningEffort: effort,
			reasoningSummary: "auto",
			...(cache && {
				promptCacheKey: cache.promptCacheKey,
				promptCacheOptions: { mode: "implicit", ttl: "30m" },
			}),
		} satisfies OpenAIResponsesProviderOptions,
	};
}

/** Model ID for the Solutions Architect agent building a NEW app. */
export const SA_BUILD_MODEL = "gpt-5.6-sol";

/** Model ID for the Solutions Architect agent editing an EXISTING app.
 * Same model as builds, at a lower reasoning effort (`SA_EDIT_REASONING`):
 * per the intelligence-per-cost leaderboards, every terra effort tier is
 * dominated by sol or luna at a lower price, so terra holds no SA role —
 * edits buy their savings through effort, not a weaker model. One model
 * across both roles also keeps a thread's reasoning items replayable:
 * encrypted reasoning is model-bound, so a build→edit continuation never
 * crosses models mid-thread. */
export const SA_EDIT_MODEL = "gpt-5.6-sol";

/** Reasoning effort for the Solutions Architect building a NEW app —
 * the quality-first ceiling; a ground-up design is the hardest call site. */
export const SA_BUILD_REASONING: { effort: ReasoningEffort } = {
	effort: "xhigh",
};

/** Reasoning effort for the Solutions Architect editing an EXISTING app —
 * edits are narrower than a ground-up build, so they run medium effort. */
export const SA_EDIT_REASONING: { effort: ReasoningEffort } = {
	effort: "medium",
};

/**
 * Pricing per million tokens, keyed by model ID.
 *
 * These are OpenAI's published rates, and with a direct key the token-math
 * estimate IS the bill: uncached input at the base rate (the 2× long-context
 * rate starts past 272k tokens per request, which Nova's prompts stay
 * under), cache reads at 0.1×, cache writes at the published 1.25× write
 * surcharge whenever usage reports a write bucket, output at the output
 * rate. There is no separate metered "actual" — `estimateCost` is the one
 * cost figure every ledger and summary records.
 */
export const MODEL_PRICING: Record<
	string,
	{ input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
	"gpt-5.6-sol": {
		input: 5,
		output: 30,
		cacheWrite: 6.25,
		cacheRead: 0.5,
	},
	"gpt-5.6-luna": {
		input: 1,
		output: 6,
		cacheWrite: 1.25,
		cacheRead: 0.1,
	},
};

export const DEFAULT_PRICING = {
	input: 2.5,
	output: 15,
	cacheWrite: 3.125,
	cacheRead: 0.25,
};
