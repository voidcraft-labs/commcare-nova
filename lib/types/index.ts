import type { UIMessage } from 'ai'

export interface FileAttachment {
  name: string
  type: string
  data: string // base64 encoded
  size: number
}

export interface AppDefinition {
  name: string
  files: Record<string, string> // filepath -> content
}

export interface ValidationResult {
  success: boolean
  skipped: boolean
  skipReason?: string
  errors: string[]
  stdout: string
  stderr: string
}

export interface GenerationProgress {
  status: 'scaffolding' | 'generating_module' | 'generating_form' | 'validating' | 'fixing' | 'expanding' | 'success' | 'failed'
  message: string
  attempt: number
  totalSteps?: number
  completedSteps?: number
  currentStep?: string
}

export interface AppSettings {
  apiKey: string | null
  hqServer: string
  hqDomain: string
}

// Web-specific types
export type BuilderPhase =
  | 'idle'
  | 'chatting'
  | 'scaffolding'
  | 'modules'
  | 'forms'
  | 'validating'
  | 'fixing'
  | 'compiling'
  | 'done'
  | 'error'

export interface Build {
  id: string
  name: string
  phase: BuilderPhase
  createdAt: number
  updatedAt: number
  blueprint?: import('../schemas/blueprint').AppBlueprint
  conversation: UIMessage[]
  errors: string[]
}

export interface SSEEvent {
  event: string
  data: any
}
