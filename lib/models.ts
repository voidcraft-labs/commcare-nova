/**
 * Central model configuration.
 *
 * Anthropic SDK calls use full model IDs (e.g. "claude-sonnet-4-6-20250514").
 * Vercel AI SDK calls use short aliases (e.g. "claude-sonnet-4-6") resolved by the provider.
 */

/**
 * Reasoning effort levels for Anthropic adaptive thinking.
 *
 * `xhigh` sits between `high` and `max` — introduced with Opus 4.7. In practice
 * it delivers better quality than 4.6's `max` at a lower token budget, because
 * 4.7 `max` can emit ~1.4× the thinking tokens of prior models.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Fallback model for GenerationContext methods when no model is specified. */
export const MODEL_DEFAULT = "claude-sonnet-4-6";

/** Model ID for the Solutions Architect agent. */
export const SA_MODEL = "claude-opus-4-7";

/** Reasoning configuration for the Solutions Architect agent. */
export const SA_REASONING: { effort: ReasoningEffort } = { effort: "xhigh" };

/** Pricing per million tokens, keyed by model ID (either full or alias). */
export const MODEL_PRICING: Record<
	string,
	{ input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
	"claude-sonnet-4-6": {
		input: 3,
		output: 15,
		cacheWrite: 3.75,
		cacheRead: 0.3,
	},
	"claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
	"claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
	"claude-haiku-4-5-20251001": {
		input: 1,
		output: 5,
		cacheWrite: 1.25,
		cacheRead: 0.1,
	},
};

export const DEFAULT_PRICING = {
	input: 3,
	output: 15,
	cacheWrite: 3.75,
	cacheRead: 0.3,
};
