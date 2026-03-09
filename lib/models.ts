/**
 * Central model configuration.
 *
 * Anthropic SDK calls use full model IDs (e.g. "claude-sonnet-4-6-20250514").
 * Vercel AI SDK calls use short aliases (e.g. "claude-sonnet-4-6") resolved by the provider.
 */

/** Default model for structured generation (tiers 1-3). */
export const MODEL_GENERATION = 'claude-sonnet-4-6'

/** Model for the validation fixer (cheap, fast). */
export const MODEL_FIXER = 'claude-haiku-4-5-20251001'

/** Model for the chat conversation (Vercel AI SDK alias). */
export const MODEL_CHAT = 'claude-sonnet-4-6'

/** Pricing per million tokens, keyed by model ID (either full or alias). */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
}

export const DEFAULT_PRICING = { input: 3, output: 15 }
