export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

export interface PipelineStageConfig {
  model: string
  maxOutputTokens: number
  reasoning: boolean
  reasoningEffort: ReasoningEffort
}

export interface PipelineConfig {
  solutionsArchitect: PipelineStageConfig
  schemaGeneration: PipelineStageConfig
  scaffold: PipelineStageConfig
  formGeneration: PipelineStageConfig
}

export interface NovaSettings {
  apiKey: string
  pipeline: PipelineConfig
}
