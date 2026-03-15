/**
 * Central model configuration.
 *
 * Anthropic SDK calls use full model IDs (e.g. "claude-sonnet-4-6-20250514").
 * Vercel AI SDK calls use short aliases (e.g. "claude-sonnet-4-6") resolved by the provider.
 */

import type { PipelineConfig } from './types/settings'

/** Default model for structured generation (scaffold). */
export const MODEL_GENERATION = 'claude-sonnet-4-6'

/** Model for app content generation (columns + all forms). */
export const MODEL_APP_CONTENT = 'claude-opus-4-6'

/** Model for the validation fixer (cheap, fast). */
export const MODEL_FIXER = 'claude-haiku-4-5-20251001'

/** Model for the Product Manager agent (Tier 0). */
export const MODEL_PM = 'claude-sonnet-4-6'

/** Model families that support extended thinking / reasoning. */
const REASONING_PREFIXES = ['claude-opus', 'claude-sonnet']

/** Check whether a model ID supports reasoning (extended thinking). */
export function modelSupportsReasoning(modelId: string): boolean {
  return REASONING_PREFIXES.some(prefix => modelId.startsWith(prefix))
}

/** Default pipeline configuration — matches the hardcoded values used before settings existed. */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  pm: { model: MODEL_APP_CONTENT, maxOutputTokens: 0, reasoning: true, reasoningEffort: 'high' },
  scaffold: { model: MODEL_APP_CONTENT, maxOutputTokens: 0, reasoning: true, reasoningEffort: 'high' },
  appContent: { model: MODEL_APP_CONTENT, maxOutputTokens: 0, reasoning: true, reasoningEffort: 'high' },
  editArchitect: { model: MODEL_GENERATION, maxOutputTokens: 0, reasoning: false, reasoningEffort: 'high' },
  singleFormRegen: { model: MODEL_APP_CONTENT, maxOutputTokens: 0, reasoning: true, reasoningEffort: 'high' },
}

/** Pricing per million tokens, keyed by model ID (either full or alias). */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
}

export const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }
