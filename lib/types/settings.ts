export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

export interface PipelineStageConfig {
  model: string
  maxOutputTokens: number
  reasoning: boolean
  reasoningEffort: ReasoningEffort
}

export interface PipelineConfig {
  requirementsAnalyst: PipelineStageConfig
  scaffold: PipelineStageConfig
  appContent: PipelineStageConfig
  editArchitect: PipelineStageConfig
  singleFormRegen: PipelineStageConfig
}

export interface NovaSettings {
  apiKey: string
  pipeline: PipelineConfig
}
