/**
 * Central model configuration.
 *
 * Every LLM call routes through the Vercel AI Gateway, so model ids use the
 * gateway's `creator/model-name` format (e.g. "openai/gpt-5.6-sol"). Swapping
 * a constant here switches the model on every surface that uses it — no
 * provider wiring changes needed. List the available ids:
 * `curl -s https://ai-gateway.vercel.sh/v1/models`.
 */

/**
 * Reasoning effort levels for OpenAI reasoning models (GPT-5.6 family) —
 * exactly the values the API accepts for these models (verified against the
 * wire's own error enumeration; there is no `max` tier here). `xhigh` is the
 * quality-first ceiling. Reasoning tokens bill as output tokens.
 */
export type ReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

/** Fallback model for GenerationContext methods when no model is specified. */
export const MODEL_DEFAULT = "openai/gpt-5.6-terra";

/** Model ID for the Solutions Architect agent building a NEW app. */
export const SA_BUILD_MODEL = "openai/gpt-5.6-sol";

/** Model ID for the Solutions Architect agent editing an EXISTING app —
 * edits are narrower than a ground-up build, so they run the mid-tier model. */
export const SA_EDIT_MODEL = "openai/gpt-5.6-terra";

/** Reasoning configuration for the Solutions Architect agent (both modes). */
export const SA_REASONING: { effort: ReasoningEffort } = { effort: "xhigh" };

/**
 * Pricing per million tokens, keyed by gateway model ID.
 *
 * Base-tier rates: OpenAI bills input past 272k tokens per request at 2×
 * these, which Nova's prompts stay under. Cache writes bill at 1.25× input;
 * cache reads at 0.1× input.
 */
export const MODEL_PRICING: Record<
	string,
	{ input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
	"openai/gpt-5.6-sol": {
		input: 5,
		output: 30,
		cacheWrite: 6.25,
		cacheRead: 0.5,
	},
	"openai/gpt-5.6-terra": {
		input: 2.5,
		output: 15,
		cacheWrite: 3.125,
		cacheRead: 0.25,
	},
	"openai/gpt-5.6-luna": {
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
