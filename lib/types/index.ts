import type { UIMessage } from 'ai'
import type { AppBlueprint } from '../schemas/blueprint'
import type { BuilderPhase } from '../services/builder'

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
