/**
 * Log Replay — extracts replay stages from a v3 RunLog.
 *
 * Walks through `log.turns` sequentially. Each turn's tool calls become replay
 * stages. Emissions on each turn are distributed across stages by
 * moduleIndex/formIndex matching.
 *
 * Chat messages are built progressively from turn text/reasoning/tool_calls.
 * The `applyToBuilder` closure replays the turn's emissions through the
 * shared `applyDataPart` function — the same code path as real-time streaming.
 */
import type { UIMessage } from 'ai'
import type { RunLog, Turn, Emission } from './runLogger'
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
  doneIndex: number
  appName?: string
}

interface ExtractionError {
  success: false
  error: string
}

export type ExtractionResult = ExtractionSuccess | ExtractionError

/** Minimal tool call shape used by stage derivation helpers. */
interface ToolCallRef {
  name: string
  args: unknown
  output?: unknown
}

// ── Extraction ──────────────────────────────────────────────────────────

export function extractReplayStages(log: RunLog): ExtractionResult {
  if (log.version !== 3 || !log.turns?.length) {
    return { success: false, error: 'Unsupported log format. Only v3 logs are supported.' }
  }

  const stages: ReplayStage[] = []

  let accumulatedParts: any[] = []
  let currentRequest = -1
  let baseMessages: UIMessage[] = []
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

  for (const turn of log.turns) {
    // Request boundary — finalize previous assistant message, add next user message
    if (turn.request !== currentRequest) {
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
      currentRequest = turn.request
      const userMsg = log.user_messages[currentRequest]
      if (userMsg) {
        baseMessages = [
          ...baseMessages,
          {
            id: userMsg.id,
            role: 'user',
            parts: [{ type: 'text', text: userMsg.text }],
            content: userMsg.text,
          } as UIMessage,
        ]
      }
    }

    // Track scaffold from emissions
    for (const em of turn.emissions) {
      if (em.type === 'data-scaffold') scaffold = em.data
    }

    // Accumulate all parts into progressive assistant message
    if (turn.reasoning) {
      accumulatedParts.push({ type: 'reasoning', reasoning: turn.reasoning })
    }
    if (turn.text) {
      accumulatedParts.push({ type: 'text', text: turn.text })
    }
    for (const tc of turn.tool_calls ?? []) {
      accumulatedParts.push({
        type: `tool-${tc.name}`,
        toolCallId: `replay-${turn.index}-${tc.name}`,
        toolName: tc.name,
        input: tc.args,
        state: 'output-available',
        ...(tc.output !== undefined ? { output: tc.output } : {}),
      })
    }

    // Create stages from interesting tool calls
    const interestingCalls = flattenInterestingCalls(turn)

    if (interestingCalls.length === 0) {
      if (turn.emissions.length > 0) {
        const turnEmissions = turn.emissions
        stages.push({
          header: 'Update',
          messages: buildProgressiveMessages(),
          applyToBuilder: (b) => {
            for (const emission of turnEmissions) {
              applyDataPart(b, emission.type, emission.data)
            }
          },
        })
      }
    } else if (interestingCalls.length === 1) {
      const header = toolToHeader(interestingCalls[0].name)!
      const turnEmissions = turn.emissions
      stages.push({
        header,
        subtitle: deriveSubtitle(interestingCalls[0], turnEmissions, scaffold),
        messages: buildProgressiveMessages(),
        applyToBuilder: (b) => {
          for (const emission of turnEmissions) {
            applyDataPart(b, emission.type, emission.data)
          }
        },
      })
    } else {
      const emissionMap = distributeEmissions(turn.emissions, interestingCalls)
      for (let i = 0; i < interestingCalls.length; i++) {
        const tc = interestingCalls[i]
        const emissions = emissionMap.get(i) ?? []
        stages.push({
          header: toolToHeader(tc.name)!,
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

  // Done stage
  const doneIndex = stages.length
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

  return { success: true, stages, doneIndex, appName: log.app_name ?? undefined }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Flatten a turn's tool calls into interesting (stage-producing) calls. */
function flattenInterestingCalls(turn: Turn): ToolCallRef[] {
  const result: ToolCallRef[] = []
  for (const tc of turn.tool_calls ?? []) {
    if (toolToHeader(tc.name) !== undefined) {
      result.push(tc)
    }
  }
  return result
}

/**
 * Distribute a turn's emissions across multiple tool calls by matching
 * moduleIndex/formIndex from emission data to tool call args.
 * Unmatched emissions go to the first tool call.
 */
function distributeEmissions(emissions: Emission[], toolCalls: ToolCallRef[]): Map<number, Emission[]> {
  const result = new Map<number, Emission[]>()
  for (let i = 0; i < toolCalls.length; i++) result.set(i, [])

  for (const em of emissions) {
    const d = em.data as Record<string, any>
    let matchedIdx = -1

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const args = tc.args as Record<string, any>

      if ((tc.name === 'addQuestions') &&
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
      result.get(0)!.push(em)
    }
  }

  return result
}

/** Map tool call name to replay stage header. Returns undefined for non-stage tools. */
function toolToHeader(toolName: string): string | undefined {
  switch (toolName) {
    case 'askQuestions': return 'Conversation'
    case 'generateSchema': return 'Data Model'
    case 'generateScaffold': return 'Scaffold'
    case 'addModule': return 'Module'
    case 'addQuestions': return 'Form'
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
    default: return undefined
  }
}

function deriveSubtitle(tc: ToolCallRef | undefined, emissions: Emission[], scaffold: any): string | undefined {
  if (!tc) return undefined
  const args = tc.args as Record<string, any>

  switch (tc.name) {
    case 'askQuestions': return args?.header
    case 'addModule': {
      const name = scaffold?.modules?.[args?.moduleIndex]?.name
      return name ?? `Module ${args?.moduleIndex}`
    }
    case 'addQuestions': {
      const formEm = emissions.find(e => e.type === 'data-form-done' || e.type === 'data-form-updated')
      const formName = (formEm?.data as any)?.form?.name
      if (formName) return formName
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
  doneIndex: number
  appName?: string
}

let replayStore: ReplayData | undefined

export function setReplayData(stages: ReplayStage[], doneIndex: number, appName?: string) {
  replayStore = { stages, doneIndex, appName }
}

export function getReplayData(): ReplayData | undefined {
  return replayStore
}

export function clearReplayData() {
  replayStore = undefined
}
