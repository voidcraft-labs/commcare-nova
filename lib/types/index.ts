import type { UIMessage } from 'ai'
import type { BlueprintForm, AppBlueprint } from '../schemas/blueprint'
import type { ClaudeUsage } from '../usage'

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
  blueprint?: AppBlueprint
  conversation: UIMessage[]
  errors: string[]
}

/** NDJSON events streamed from the /api/blueprint/scaffold endpoint */
export type ScaffoldStreamEvent =
  | { type: 'scaffold_module'; moduleIndex: number; module: { name: string; case_type?: string | null; purpose: string; forms: Array<{ name: string; type: string; purpose: string }> } }
  | { type: 'scaffold_case_type'; caseTypeIndex: number; caseType: { name: string; case_name_property: string; properties: Array<{ name: string; label: string }> } }
  | { type: 'scaffold_meta'; appName: string; description: string }
  | { type: 'scaffold_done'; scaffold: import('../schemas/blueprint').Scaffold; usage: ClaudeUsage[] }
  | { type: 'error'; message: string }

/** NDJSON events streamed from the /api/blueprint/fill endpoint */
export type FillStreamEvent =
  | { type: 'phase'; phase: 'modules' | 'forms' | 'validating' | 'fixing' }
  | { type: 'module_done'; moduleIndex: number; caseListColumns: Array<{ field: string; header: string }> | null }
  | { type: 'form_done'; moduleIndex: number; formIndex: number; form: BlueprintForm }
  | { type: 'progress'; message: string; completed: number; total: number }
  | { type: 'fix_attempt'; attempt: number; errorCount: number }
  | { type: 'usage'; usage: ClaudeUsage }
  | { type: 'done'; blueprint: AppBlueprint; hqJson: Record<string, any>; usage: ClaudeUsage[] }
  | { type: 'error'; message: string }
