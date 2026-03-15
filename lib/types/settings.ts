export interface PipelineStageConfig {
  model: string
  maxOutputTokens: number
}

export interface PipelineConfig {
  pm: PipelineStageConfig
  scaffold: PipelineStageConfig
  appContent: PipelineStageConfig
  editArchitect: PipelineStageConfig
  singleFormRegen: PipelineStageConfig
}

export interface NovaSettings {
  apiKey: string
  pipeline: PipelineConfig
}
