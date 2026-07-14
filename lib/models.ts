/**
 * Central model configuration.
 *
 * Every LLM call routes through the Vercel AI Gateway, so model ids use the
 * gateway's `creator/model-name` format (e.g. "openai/gpt-5.6-sol"). Swapping
 * a constant here switches the model on every surface that uses it — no
 * provider wiring changes needed. List the available ids:
 * `curl -s https://ai-gateway.vercel.sh/v1/models`.
 */

import type { GatewayProviderOptions } from "@ai-sdk/gateway";
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
export const MODEL_DEFAULT = "openai/gpt-5.6-sol";

/**
 * Gateway-level provider options EVERY Nova LLM call carries (under the
 * `gateway` key of `providerOptions`, beside the `openai` reasoning options).
 * `disallowPromptTraining` restricts routing to providers that do not train
 * on prompt data — user content never becomes training data, on any surface
 * (SA, extraction, scripts). `caching: "auto"` opts into the gateway's
 * automatic prompt-caching behavior wherever the routed provider supports it.
 */
export const GATEWAY_PROVIDER_OPTIONS = {
	disallowPromptTraining: true,
	caching: "auto",
} as const satisfies GatewayProviderOptions;

/**
 * The ONE provider-options literal every reasoning call carries — the
 * `openai` reasoning options beside `GATEWAY_PROVIDER_OPTIONS`. Call this
 * instead of restating the shape: a copy that drifts (say, drops
 * `reasoningSummary`) silently darkens that surface's live-thinking feed
 * with no error anywhere.
 *
 * `reasoningSummary: 'auto'` is required for human-readable reasoning
 * summaries to stream back as `reasoning-delta` parts; without it the
 * reasoning phase is silent and nothing feeds the live-progress surfaces.
 */
export function reasoningProviderOptions(effort: ReasoningEffort) {
	// `satisfies` (not an annotation) so the literal's own type flows into
	// providerOptions' JSONObject requirement, while a misplaced or
	// misspelled key is still rejected — the AI SDK's Zod schema silently
	// strips unknown fields, so an unchecked typo would appear to work and
	// never reach the wire.
	return {
		openai: {
			reasoningEffort: effort,
			reasoningSummary: "auto",
		} satisfies OpenAIResponsesProviderOptions,
		gateway: GATEWAY_PROVIDER_OPTIONS,
	};
}

/**
 * The actual USD amount the gateway charged for one call, read from the
 * response's `providerMetadata.gateway.cost` (a decimal string, e.g.
 * "0.0331125") — the gateway's own meter, not a token-math reconstruction.
 * Returns 0 when the metadata is absent or unparseable (a test double, a
 * failed call) so accumulation degrades to under-count, never NaN.
 */
export function gatewayActualCost(providerMetadata: unknown): number {
	const cost = (
		providerMetadata as { gateway?: { cost?: unknown } } | undefined
	)?.gateway?.cost;
	const n =
		typeof cost === "string"
			? Number(cost)
			: typeof cost === "number"
				? cost
				: Number.NaN;
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Model ID for the Solutions Architect agent building a NEW app. */
export const SA_BUILD_MODEL = "openai/gpt-5.6-sol";

/** Model ID for the Solutions Architect agent editing an EXISTING app.
 * Same model as builds, at a lower reasoning effort (`SA_EDIT_REASONING`):
 * per the intelligence-per-cost leaderboards, every terra effort tier is
 * dominated by sol or luna at a lower price, so terra holds no SA role —
 * edits buy their savings through effort, not a weaker model. One model
 * across both roles also keeps a thread's reasoning items replayable:
 * encrypted reasoning is model-bound, so a build→edit continuation never
 * crosses models mid-thread. */
export const SA_EDIT_MODEL = "openai/gpt-5.6-sol";

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
 * Pricing per million tokens, keyed by gateway model ID.
 *
 * Base-tier rates: OpenAI bills input past 272k tokens per request at 2×
 * these, which Nova's prompts stay under. Cache reads bill at 0.1× input.
 * The cacheWrite rates are OpenAI's published 1.25× write surcharge. What we
 * OBSERVE through the gateway: our calls carry no `cacheWriteTokens` in usage
 * and are charged no write surcharge (fresh input bills at exactly the plain
 * rate per the gateway's own `providerMetadata.gateway.cost`), so the write
 * arm of an estimate never fires today — whether OpenAI bills Vercel for
 * those writes upstream is not observable from here. The settled per-run
 * truth is the gateway-metered actual (`gatewayActualCost`), which the run
 * summary records beside the estimate.
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
