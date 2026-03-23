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
  apiKey: z.string().min(1, 'API key is required'),
  blueprint: appBlueprintSchema.optional(),
  runId: z.string().optional(),
  pipelineConfig: pipelineConfigSchema.optional(),
})

export const modelsRequestSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
})
