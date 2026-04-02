import { z } from 'zod'
import { appBlueprintSchema } from './blueprint'

const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'max'])

const pipelineStageConfigSchema = z.object({
  model: z.string(),
  maxOutputTokens: z.number(),
  reasoning: z.boolean(),
  reasoningEffort: reasoningEffortSchema,
})

const pipelineConfigSchema = z.object({
  solutionsArchitect: pipelineStageConfigSchema,
}).partial()

export const chatRequestSchema = z.object({
  /** BYOK API key — optional when the user is authenticated (server key used instead). */
  apiKey: z.string().optional(),
  blueprint: appBlueprintSchema.optional(),
  runId: z.string().optional(),
  /** Firestore project ID — present after first save so subsequent saves update the same doc. */
  projectId: z.string().optional(),
  pipelineConfig: pipelineConfigSchema.optional(),
})

export const modelsRequestSchema = z.object({
  /** BYOK API key — optional when the user is authenticated (server key used instead). */
  apiKey: z.string().optional(),
})
