/**
 * Log Replay — extracts replay stages from a RunLog and provides a module-level store.
 *
 * Walks through each assistant message's parts in order. Tool call parts
 * (tool-generateSchema, tool-addModule, etc.) create replay stages whose
 * `messages` are the conversation truncated to that point — so the chat
 * sidebar progressively reveals the SA's commentary as you step through.
 *
 * Actual structured output data (schema, scaffold, form content) comes from
 * the RunLog `events` array, not the tool part summaries.
 */
import type { UIMessage } from 'ai'
import type { RunLog, RunEvent } from './runLogger'
import type { Builder } from './builder'
import type { AppBlueprint, Scaffold, CaseType } from '@/lib/schemas/blueprint'
import { processSingleFormOutput } from '@/lib/schemas/contentProcessing'

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

/** Find the first generation event output whose label starts with `prefix` (case-insensitive). */
function findGenerationOutput(events: RunEvent[], prefix: string): unknown | null {
  const lower = prefix.toLowerCase()
  for (const event of events) {
    if (event.type === 'generation' && event.label.toLowerCase().startsWith(lower)) {
      if (event.output != null) return event.output
    }
  }
  return null
}

/**
 * Extract ordered replay stages from a RunLog.
 *
 * Each stage carries:
 * - `messages`: conversation truncated to the current tool call (progressive chat)
 * - `applyToBuilder`: closure that sets the builder state for that stage
 */
export function extractReplayStages(log: RunLog): ExtractionResult {
  const { events, conversation } = log
  if (!conversation?.length) {
    return { success: false, error: 'No conversation data.' }
  }

  const stages: ReplayStage[] = []
  let scaffold: Scaffold | null = null
  let caseTypes: CaseType[] = []
  let lastAssistantMsgIdx = -1

  /** Conversation up to (and including) partIndex of the assistant message at msgIdx. */
  function messagesUpTo(msgIdx: number, partIdx: number): UIMessage[] {
    return [
      ...conversation.slice(0, msgIdx),
      { ...conversation[msgIdx], parts: conversation[msgIdx].parts.slice(0, partIdx + 1) },
    ]
  }

  for (let msgIdx = 0; msgIdx < conversation.length; msgIdx++) {
    const msg = conversation[msgIdx]
    if (msg.role !== 'assistant') continue
    lastAssistantMsgIdx = msgIdx

    for (let partIdx = 0; partIdx < msg.parts.length; partIdx++) {
      const part = msg.parts[partIdx] as Record<string, any>

      switch (part.type as string) {
        case 'tool-askQuestions': {
          stages.push({
            header: 'Conversation',
            subtitle: part.input?.header,
            messages: messagesUpTo(msgIdx, partIdx),
            applyToBuilder: () => {},
          })
          break
        }

        case 'tool-generateSchema': {
          const output = findGenerationOutput(events, 'schema')
          caseTypes = (output as any)?.case_types ?? []
          stages.push({
            header: 'Data Model',
            messages: messagesUpTo(msgIdx, partIdx),
            applyToBuilder: (b) => {
              b.startDataModel()
              if (caseTypes.length) b.setSchema(caseTypes)
            },
          })
          break
        }

        case 'tool-generateScaffold': {
          const raw = findGenerationOutput(events, 'scaffold')
          scaffold = raw as Scaffold | null
          if (scaffold?.modules?.length) {
            stages.push({
              header: 'Scaffold',
              messages: messagesUpTo(msgIdx, partIdx),
              applyToBuilder: (b) => {
                b.setScaffold(scaffold!)
                b.setPhase('forms')
              },
            })
          }
          break
        }

        case 'tool-addModule': {
          if (!scaffold) break
          const moduleIndex = part.input?.moduleIndex as number | undefined
          if (moduleIndex == null) break
          const mod = scaffold.modules[moduleIndex]
          // Columns are in the tool part output (full data, not just a summary)
          let columns = (part.output as any)?.case_list_columns
          if (!columns) {
            columns = (findGenerationOutput(events, `module ${moduleIndex}`) as any)?.case_list_columns
          }
          if (columns) {
            stages.push({
              header: mod?.name ?? `Module ${moduleIndex}`,
              subtitle: 'Columns',
              messages: messagesUpTo(msgIdx, partIdx),
              applyToBuilder: (b) => b.setModuleContent(moduleIndex, columns),
            })
          }
          break
        }

        case 'tool-addForm': {
          if (!scaffold) break
          const moduleIndex = part.input?.moduleIndex as number | undefined
          const formIndex = part.input?.formIndex as number | undefined
          if (moduleIndex == null || formIndex == null) break
          const mod = scaffold.modules[moduleIndex]
          const sf = mod?.forms[formIndex]
          if (!sf) break

          // Full form content comes from generation events (tool output only has a summary)
          const raw = (findGenerationOutput(events, `generate form "${sf.name}"`)
            ?? findGenerationOutput(events, `regenerate form "${sf.name}"`)) as any
          if (raw?.questions) {
            const ct = caseTypes.find(c => c.name === mod.case_type) ?? null
            const form = processSingleFormOutput(
              { formIndex, questions: raw.questions, close_case: raw.close_case ?? { question: '', answer: '' }, child_cases: raw.child_cases ?? [] },
              sf.name,
              sf.type as 'registration' | 'followup' | 'survey',
              ct,
            )
            stages.push({
              header: mod.name,
              subtitle: sf.name,
              messages: messagesUpTo(msgIdx, partIdx),
              applyToBuilder: (b) => b.setFormContent(moduleIndex, formIndex, form),
            })
          }
          break
        }

        case 'tool-validateApp': {
          stages.push({
            header: 'Validation',
            messages: messagesUpTo(msgIdx, partIdx),
            applyToBuilder: () => {},
          })
          break
        }
      }
    }
  }

  // ── Done stage — snapshot treeData (scaffold + partials) as the blueprint ──
  const doneMessages = lastAssistantMsgIdx >= 0
    ? messagesUpTo(lastAssistantMsgIdx, conversation[lastAssistantMsgIdx].parts.length - 1)
    : [...conversation]

  stages.push({
    header: 'Done',
    messages: doneMessages,
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
