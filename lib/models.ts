/**
 * Central model configuration.
 *
 * Anthropic SDK calls use full model IDs (e.g. "claude-sonnet-4-6-20250514").
 * Vercel AI SDK calls use short aliases (e.g. "claude-sonnet-4-6") resolved by the provider.
 */

import type { PipelineConfig } from './types/settings'

/** Fallback model for GenerationContext methods when no model is specified. */
export const MODEL_DEFAULT = 'claude-sonnet-4-6'

/** Model families that support extended thinking / reasoning. */
const REASONING_PREFIXES = ['claude-opus', 'claude-sonnet']

/** Check whether a model ID supports reasoning (extended thinking). */
export function modelSupportsReasoning(modelId: string): boolean {
  return REASONING_PREFIXES.some(prefix => modelId.startsWith(prefix))
}

/** Check whether a model ID supports "max" reasoning effort (only Opus). */
export function modelSupportsMaxReasoning(modelId: string): boolean {
  return modelId.startsWith('claude-opus')
}

/** Default pipeline configuration. */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  solutionsArchitect: { model: 'claude-opus-4-6', maxOutputTokens: 0, reasoning: true, reasoningEffort: 'max' },
  schemaGeneration: { model: 'claude-sonnet-4-6', maxOutputTokens: 0, reasoning: true, reasoningEffort: 'medium' },
  scaffold: { model: 'claude-sonnet-4-6', maxOutputTokens: 0, reasoning: true, reasoningEffort: 'medium' },
  formGeneration: { model: 'claude-sonnet-4-6', maxOutputTokens: 0, reasoning: true, reasoningEffort: 'medium' },
}

/** Pricing per million tokens, keyed by model ID (either full or alias). */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
}

export const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 }
