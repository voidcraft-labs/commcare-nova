/**
 * Central model configuration.
 *
 * Every LLM call goes straight to OpenAI through `@ai-sdk/openai` (the
 * Responses API) with the ONE server credential, `OPENAI_API_KEY`. Model ids
 * are OpenAI's own (e.g. "gpt-5.6-luna"); swapping a constant here switches
 * the model on every surface that uses it.
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

export type ReasoningEffort = NonNullable<
	OpenAIResponsesProviderOptions["reasoningEffort"]
>;

/**
 * Ask OpenAI's server-side context management to compact before the 272k-token
 * long-context price boundary. OpenAI creates the opaque encrypted checkpoint
 * and the AI SDK converts it to/from a first-class Responses item; Nova keeps
 * the complete transcript for people and projects only a compatible checkpoint
 * plus its later suffix back to the model.
 */
export const OPENAI_COMPACTION_THRESHOLD = 256_000;

/** A compaction item is replayable only inside this model-context contract. */
export const MODEL_CONTEXT_VERSION = "v1";

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
	contextManagement: [
		{ type: "compaction", compactThreshold: OPENAI_COMPACTION_THRESHOLD },
	],
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
 * implicit supplies automatic placement and also honors an explicit boundary).
 * Ordinary edit POSTs add a request-local boundary before their volatile
 * app-state tail; it changes no transcript token. The reviewed design and
 * executor loops preserve an actually growing prefix under one stable tool
 * grammar, so their latest automatic entry remains reusable without moving a
 * marker. One-shot calls (extraction, scripts) pass no cache config.
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

interface ModelRoleConfig {
	readonly modelId: string;
	readonly reasoningEffort: ReasoningEffort;
}

/**
 * The complete production LLM roster. Every call selects one semantic role;
 * there is no generic default, build-era alias, or compatibility name that can
 * silently route a call through the wrong model.
 */
export const MODEL_ROLES = {
	designAuthor: {
		modelId: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	designReviewer: {
		modelId: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	executorHelper: {
		modelId: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	buildExecutor: {
		modelId: "gpt-5.6-luna",
		reasoningEffort: "xhigh",
	},
	followUpEditor: {
		modelId: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	documentExtractor: {
		modelId: "gpt-5.6-luna",
		reasoningEffort: "xhigh",
	},
	translator: {
		modelId: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
} as const satisfies Record<string, ModelRoleConfig>;

/**
 * Pricing per million tokens, keyed by model ID.
 *
 * These are OpenAI's published short- and long-context rates. The threshold
 * applies to each call's total input independently; `UsageAccumulator` prices
 * the call before aggregating the run, so mixed models and a single
 * over-threshold call remain exact. There is no separate metered "actual" —
 * `estimateCost` is the one cost figure every ledger and summary records.
 */
export const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

export type ModelPricing = {
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
};

export type ModelPricingCard = {
	short: ModelPricing;
	long: ModelPricing;
};

export const MODEL_PRICING: Record<string, ModelPricingCard> = {
	"gpt-5.6-sol": {
		short: { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 },
		long: { input: 10, output: 45, cacheWrite: 12.5, cacheRead: 1 },
	},
	"gpt-5.6-terra": {
		short: { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
		long: { input: 4, output: 18, cacheWrite: 5, cacheRead: 0.4 },
	},
	"gpt-5.6-luna": {
		short: { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 },
		long: { input: 0.4, output: 1.8, cacheWrite: 0.5, cacheRead: 0.04 },
	},
};

/** gpt-5.6-terra's published card, the mid-family rate, so an unknown
 * model id still produces a believable estimate. */
export const DEFAULT_PRICING: ModelPricingCard = {
	short: { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
	long: { input: 4, output: 18, cacheWrite: 5, cacheRead: 0.4 },
};
