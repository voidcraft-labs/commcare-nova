/**
 * Log Replay — extracts replay stages from a v2 RunLog.
 *
 * Walks through `log.steps` sequentially. Each step with tool calls or
 * emissions becomes one or more replay stages. When a step has multiple
 * generation/mutation tool calls (e.g. addModule × 3), it's split into
 * per-tool-call stages with emissions distributed by moduleIndex/formIndex.
 *
 * Chat messages are built progressively from step text/reasoning/tool_calls.
 * The `applyToBuilder` closure replays the step's emissions through the
 * shared `applyDataPart` function — the same code path as real-time streaming.
 */
import type { UIMessage } from 'ai'
import type { RunLog, Step, StepToolCall, Emission } from './runLogger'
import type { Builder } from './builder'
import { applyDataPart } from './builder'
import type { AppBlueprint } from '@/lib/schemas/blueprint'

// ── Types ───────────────────────────────────────────────────────────────

export interface ReplayStage {
  header: string
  subtitle?: string
  messages: UIMessage[]
  applyToBuilder: (builder: Builder) => void
}

interface ExtractionSuccess {
  success: true
  stages: ReplayStage[]
  appName: string | null
}

interface ExtractionError {
  success: false
  error: string
}

export type ExtractionResult = ExtractionSuccess | ExtractionError

// ── Extraction ──────────────────────────────────────────────────────────

/**
 * Extract ordered replay stages from a v2 RunLog.
 *
 * Each stage carries:
 * - `messages`: conversation progressively built from steps (chat sidebar shows SA commentary)
 * - `applyToBuilder`: replays the step's emissions through applyDataPart
 */
export function extractReplayStages(log: RunLog): ExtractionResult {
  if ((log as any).version !== 2 || !log.steps?.length) {
    return { success: false, error: 'Unsupported log format. Only v2 logs are supported.' }
  }

  const stages: ReplayStage[] = []
  const userMessages = log.conversation.filter(m => m.role === 'user')

  // Progressive state
  let accumulatedParts: any[] = []
  let currentRequest = -1
  let baseMessages: UIMessage[] = []

  // Track scaffold for name lookups in module/form stages
  let scaffold: any = null

  function buildProgressiveMessages(): UIMessage[] {
    if (accumulatedParts.length === 0) return [...baseMessages]
    return [
      ...baseMessages,
      {
        id: `assistant-${currentRequest}`,
        role: 'assistant',
        parts: [...accumulatedParts],
        content: '',
      } as UIMessage,
    ]
  }

  for (const step of log.steps) {
    // Handle request boundary — finalize previous assistant message, add next user message
    if (step.request !== currentRequest) {
      if (currentRequest >= 0 && accumulatedParts.length > 0) {
        baseMessages = [
          ...baseMessages,
          {
            id: `assistant-${currentRequest}`,
            role: 'assistant',
            parts: [...accumulatedParts],
            content: '',
          } as UIMessage,
        ]
        accumulatedParts = []
      }
      currentRequest = step.request
      if (currentRequest < userMessages.length) {
        baseMessages = [...baseMessages, userMessages[currentRequest]]
      }
    }

    // Track scaffold from emissions (needed for module/form name lookups)
    for (const em of step.emissions) {
      if (em.type === 'data-scaffold') scaffold = em.data
    }

    // Accumulate step parts into the progressive assistant message
    if (step.reasoning) {
      accumulatedParts.push({ type: 'reasoning', reasoning: step.reasoning })
    }
    if (step.text) {
      accumulatedParts.push({ type: 'text', text: step.text })
    }
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        accumulatedParts.push({
          type: `tool-${tc.name}`,
          toolCallId: `replay-${step.index}-${tc.name}`,
          toolName: tc.name,
          input: tc.args,
          state: 'output-available',
        })
      }
    }

    // Create stages — split when a step has multiple interesting tool calls
    const interestingCalls = (step.tool_calls ?? []).filter(tc => toolToHeader(tc.name) !== null)

    if (interestingCalls.length <= 1) {
      const header = deriveStageHeader(step)
      if (header) {
        const stepEmissions = step.emissions
        stages.push({
          header,
          subtitle: deriveSubtitle(interestingCalls[0], stepEmissions, scaffold),
          messages: buildProgressiveMessages(),
          applyToBuilder: (b) => {
            for (const emission of stepEmissions) {
              applyDataPart(b, emission.type, emission.data)
            }
          },
        })
      }
    } else {
      // Multiple interesting tool calls in one step — split into per-tool-call stages
      const emissionMap = distributeEmissions(step.emissions, interestingCalls)

      for (let i = 0; i < interestingCalls.length; i++) {
        const tc = interestingCalls[i]
        const header = toolToHeader(tc.name)!
        const emissions = emissionMap.get(i) ?? []

        stages.push({
          header,
          subtitle: deriveSubtitle(tc, emissions, scaffold),
          messages: buildProgressiveMessages(),
          applyToBuilder: (b) => {
            for (const emission of emissions) {
              applyDataPart(b, emission.type, emission.data)
            }
          },
        })
      }
    }
  }

  // Done stage — snapshot treeData as the final blueprint
  stages.push({
    header: 'Done',
    messages: buildProgressiveMessages(),
    applyToBuilder: (b) => {
      const tree = b.treeData
      if (tree) {
        b.setDone({
          blueprint: { ...tree, case_types: b.caseTypes ?? null } as AppBlueprint,
          hqJson: {},
          success: true,
        })
      }
    },
  })

  if (stages.length <= 1) {
    return { success: false, error: 'This log contains no generation data.' }
  }

  return { success: true, stages, appName: log.app_name }
}

// ── Emission distribution ───────────────────────────────────────────────

/**
 * Distribute a step's emissions across multiple tool calls by matching
 * moduleIndex/formIndex from emission data to tool call args.
 * Unmatched emissions (e.g. data-phase) go to the first tool call.
 */
function distributeEmissions(emissions: Emission[], toolCalls: StepToolCall[]): Map<number, Emission[]> {
  const result = new Map<number, Emission[]>()
  for (let i = 0; i < toolCalls.length; i++) result.set(i, [])

  for (const em of emissions) {
    const d = em.data as Record<string, any>
    let matchedIdx = -1

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const args = tc.args as Record<string, any>

      if (tc.name === 'addModule' &&
          em.type === 'data-module-done' && d.moduleIndex === args.moduleIndex) {
        matchedIdx = i; break
      }
      if ((tc.name === 'addForm' || tc.name === 'regenerateForm') &&
          (em.type === 'data-form-done' || em.type === 'data-form-updated') &&
          d.moduleIndex === args.moduleIndex && d.formIndex === args.formIndex) {
        matchedIdx = i; break
      }
      if ((tc.name === 'editQuestion' || tc.name === 'addQuestion' ||
           tc.name === 'removeQuestion' || tc.name === 'updateForm') &&
          em.type === 'data-form-updated' &&
          d.moduleIndex === args.moduleIndex && d.formIndex === args.formIndex) {
        matchedIdx = i; break
      }
      if ((tc.name === 'updateModule' || tc.name === 'createModule' || tc.name === 'removeModule' ||
           tc.name === 'createForm' || tc.name === 'removeForm' || tc.name === 'renameCaseProperty') &&
          em.type === 'data-blueprint-updated') {
        matchedIdx = i; break
      }
    }

    if (matchedIdx >= 0) {
      result.get(matchedIdx)!.push(em)
    } else {
      // Unmatched emissions (data-phase, etc.) go to the first stage
      result.get(0)!.push(em)
    }
  }

  return result
}

// ── Stage header/subtitle derivation ────────────────────────────────────

/** Map tool call name → replay stage header. Returns null for read-only tools. */
function toolToHeader(toolName: string): string | null {
  switch (toolName) {
    case 'askQuestions': return 'Conversation'
    case 'generateSchema': return 'Data Model'
    case 'generateScaffold': return 'Scaffold'
    case 'addModule': return 'Module'
    case 'addForm': return 'Form'
    case 'regenerateForm': return 'Regenerate'
    case 'validateApp': return 'Validation'
    case 'editQuestion':
    case 'addQuestion':
    case 'removeQuestion':
    case 'updateModule':
    case 'updateForm':
    case 'createForm':
    case 'removeForm':
    case 'createModule':
    case 'removeModule':
    case 'renameCaseProperty':
      return 'Edit'
    case 'searchBlueprint':
    case 'getModule':
    case 'getForm':
    case 'getQuestion':
      return null
    default: return null
  }
}

function deriveStageHeader(step: Step): string | null {
  if (!step.tool_calls?.length) return step.emissions.length > 0 ? 'Update' : null
  for (const tc of step.tool_calls) {
    const header = toolToHeader(tc.name)
    if (header) return header
  }
  return null
}

/** Derive a human-readable subtitle from a tool call, using scaffold names and emission data. */
function deriveSubtitle(tc: StepToolCall | undefined, emissions: Emission[], scaffold: any): string | undefined {
  if (!tc) return undefined
  const args = tc.args as Record<string, any>

  switch (tc.name) {
    case 'askQuestions': return args?.header
    case 'addModule': {
      const name = scaffold?.modules?.[args?.moduleIndex]?.name
      return name ?? `Module ${args?.moduleIndex}`
    }
    case 'addForm':
    case 'regenerateForm': {
      // Try emission data first (has the actual assembled form)
      const formEm = emissions.find(e => e.type === 'data-form-done' || e.type === 'data-form-updated')
      const formName = (formEm?.data as any)?.form?.name
      if (formName) return formName
      // Fallback to scaffold
      const sfName = scaffold?.modules?.[args?.moduleIndex]?.forms?.[args?.formIndex]?.name
      return sfName ?? `Form ${args?.formIndex}`
    }
    case 'editQuestion': return `Update ${args?.questionId}`
    case 'addQuestion': return `Add ${(args?.question as any)?.id ?? 'question'}`
    case 'removeQuestion': return `Remove ${args?.questionId}`
    case 'updateModule': return 'Update module'
    case 'updateForm': return 'Update form'
    case 'createForm': return `Add form "${args?.name}"`
    case 'removeForm': return 'Remove form'
    case 'createModule': return `Add module "${args?.name}"`
    case 'removeModule': return 'Remove module'
    case 'renameCaseProperty': return `Rename ${args?.oldName} → ${args?.newName}`
    default: return undefined
  }
}

// ── Module-level singleton store ────────────────────────────────────────

interface ReplayData {
  stages: ReplayStage[]
  appName: string | null
}

let replayStore: ReplayData | null = null

export function setReplayData(stages: ReplayStage[], appName: string | null) {
  replayStore = { stages, appName }
}

export function getReplayData(): ReplayData | null {
  return replayStore
}

export function clearReplayData() {
  replayStore = null
}
