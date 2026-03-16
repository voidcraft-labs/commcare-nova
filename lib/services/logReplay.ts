/**
 * Log Replay — extracts replay stages from a RunLog and provides a module-level store.
 *
 * Each stage carries two things:
 * - `messages`: cumulative chat messages to display (always present)
 * - `applyToBuilder`: a closure that sets the builder state (no-op for conversation-only stages)
 *
 * Call sites never inspect stage types — they just call applyToBuilder and set messages.
 */
import type { UIMessage } from 'ai'
import type { RunLog, RunEvent } from './runLogger'
import type { Builder } from './builder'
import type { Scaffold, BlueprintForm, CaseType } from '@/lib/schemas/blueprint'
import {
  processSingleFormOutput,
  stripEmpty,
  applyDefaults,
  buildQuestionTree,
  type FlatQuestion,
} from '@/lib/schemas/contentProcessing'

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

// ── Extraction helpers ──────────────────────────────────────────────────

/** Find a generation sub-result output by label prefix in RunLog events. */
function findOutput(events: RunEvent[], labelPrefix: string): unknown | null {
  for (const event of events) {
    if (event.type === 'generation' && event.label.toLowerCase().startsWith(labelPrefix.toLowerCase())) {
      if (event.output != null) return event.output
    }
  }

  for (const event of events) {
    if (event.type !== 'orchestration' || !event.tool_calls) continue
    for (const tc of event.tool_calls) {
      if (tc.result == null || typeof tc.result !== 'object') continue
      const r = tc.result as Record<string, unknown>
      if (r.output != null && tc.name?.toLowerCase().includes(labelPrefix.toLowerCase())) {
        return r.output
      }
    }
  }

  return null
}

/** Find all tool call results matching a tool name from SA orchestration events. */
function findToolResults(events: RunEvent[], toolName: string): Array<{ args: any; result: any }> {
  const results: Array<{ args: any; result: any }> = []
  for (const event of events) {
    if (event.type !== 'orchestration' || !event.tool_calls) continue
    for (const tc of event.tool_calls) {
      if (tc.name === toolName && tc.result != null) {
        results.push({ args: tc.args ?? {}, result: tc.result })
      }
    }
  }
  return results
}

/**
 * Extract ordered replay stages from a RunLog.
 *
 * Handles logs from the SA architecture: individual generateSchema,
 * generateScaffold, addModule, and addForm tool calls.
 */
export function extractReplayStages(log: RunLog): ExtractionResult {
  const { events } = log
  const stages: ReplayStage[] = []
  const noop = () => {}

  // ── Conversation stages ───────────────────────────────────────────
  let lastMessages: UIMessage[] = []
  const conversation = log.conversation ?? []

  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i].role === 'assistant') {
      lastMessages = conversation.slice(0, i + 1)
      const n = stages.length + 1
      stages.push({
        header: 'Conversation',
        subtitle: stages.length === 0 ? undefined : `Exchange ${n}`,
        messages: lastMessages,
        applyToBuilder: noop,
      })
    }
  }
  if (conversation.length > 0 && lastMessages.length < conversation.length) {
    lastMessages = [...conversation]
    const n = stages.length + 1
    stages.push({
      header: 'Conversation',
      subtitle: stages.length === 0 ? undefined : `Exchange ${n}`,
      messages: lastMessages,
      applyToBuilder: noop,
    })
  }

  // ── Scaffold ──────────────────────────────────────────────────────
  const scaffoldRaw = findOutput(events, 'scaffold')
  const scaffold = scaffoldRaw as Scaffold | null

  if (!scaffold?.modules?.length) {
    if (stages.length > 0) {
      return { success: true, stages, appName: log.app_name }
    }
    return { success: false, error: 'This log contains no conversation or generation data.' }
  }

  // Case types come from the generateSchema tool result (separate from scaffold)
  const schemaOutput = findOutput(events, 'schema')
  const caseTypes: CaseType[] = (schemaOutput as any)?.case_types ?? []

  stages.push({
    header: 'Scaffold',
    messages: lastMessages,
    applyToBuilder: (b) => {
      b.setScaffold(scaffold)
      b.setPhase('forms')
    },
  })

  // ── Module columns (from addModule tool calls or Module N sub-results) ──
  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const mod = scaffold.modules[mIdx]
    // Try SA addModule tool results
    const moduleResults = findToolResults(events, 'addModule')
    const match = moduleResults.find(r => r.args?.moduleIndex === mIdx || r.result?.moduleIndex === mIdx)

    if (match?.result?.case_list_columns) {
      const columns = match.result.case_list_columns
      stages.push({
        header: mod.name,
        subtitle: 'Columns',
        messages: lastMessages,
        applyToBuilder: (b) => b.setModuleContent(mIdx, columns),
      })
    } else {
      // Try sub-result label match
      const colOutput = findOutput(events, `module ${mIdx}`)
      if (colOutput && typeof colOutput === 'object' && 'case_list_columns' in (colOutput as any)) {
        const columns = (colOutput as any).case_list_columns
        if (columns) {
          stages.push({
            header: mod.name,
            subtitle: 'Columns',
            messages: lastMessages,
            applyToBuilder: (b) => b.setModuleContent(mIdx, columns),
          })
        }
      }
    }
  }

  // ── Form content (from addForm tool calls or Generate form sub-results) ──
  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const mod = scaffold.modules[mIdx]
    const ct = caseTypes.find(c => c.name === mod.case_type) ?? null

    for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
      const sf = mod.forms[fIdx]

      // Try SA addForm tool results (these contain the full generated form)
      const formResults = findToolResults(events, 'addForm')
      const match = formResults.find(r =>
        r.args?.moduleIndex === mIdx && r.args?.formIndex === fIdx
      )

      if (match?.result?.questionCount != null) {
        // The addForm tool returns a summary, but the actual form is on the blueprint.
        // Try to find the form generation sub-result instead.
        const formOutput = findOutput(events, `generate form "${sf.name}"`)
        if (formOutput && typeof formOutput === 'object' && 'questions' in (formOutput as any)) {
          const raw = formOutput as any
          const form = processSingleFormOutput(
            { formIndex: fIdx, questions: raw.questions, close_case: raw.close_case, child_cases: raw.child_cases },
            sf.name,
            sf.type as 'registration' | 'followup' | 'survey',
            ct,
          )
          stages.push({
            header: mod.name,
            subtitle: sf.name,
            messages: lastMessages,
            applyToBuilder: (b) => b.setFormContent(mIdx, fIdx, form),
          })
          continue
        }
      }

      // Try sub-result label match for individual form generation
      const formOutput = findOutput(events, `generate form "${sf.name}"`)
        ?? findOutput(events, `regenerate form "${sf.name}"`)
      if (formOutput && typeof formOutput === 'object' && 'questions' in (formOutput as any)) {
        const raw = formOutput as any
        const form = processSingleFormOutput(
          { formIndex: fIdx, questions: raw.questions, close_case: raw.close_case, child_cases: raw.child_cases },
          sf.name,
          sf.type as 'registration' | 'followup' | 'survey',
          ct,
        )
        stages.push({
          header: mod.name,
          subtitle: sf.name,
          messages: lastMessages,
          applyToBuilder: (b) => b.setFormContent(mIdx, fIdx, form),
        })
      }
    }
  }

  // ── Done stage ────────────────────────────────────────────────────
  // Build a blueprint from whatever we've collected
  const blueprint = {
    app_name: scaffold.app_name,
    case_types: caseTypes.length > 0 ? caseTypes : null,
    modules: scaffold.modules.map((sm, mIdx) => {
      // Find columns for this module from stages
      const colStage = stages.find(s => s.header === sm.name && s.subtitle === 'Columns')
      let caseListColumns: Array<{ field: string; header: string }> | undefined

      // Re-extract columns from the stage's closure (we stored them in the stage)
      const moduleResults = findToolResults(events, 'addModule')
      const colMatch = moduleResults.find(r => r.args?.moduleIndex === mIdx || r.result?.moduleIndex === mIdx)
      if (colMatch?.result?.case_list_columns) {
        caseListColumns = colMatch.result.case_list_columns
      }

      return {
        name: sm.name,
        ...(sm.case_type != null && { case_type: sm.case_type }),
        forms: sm.forms.map(sf => ({
          name: sf.name,
          type: sf.type as 'registration' | 'followup' | 'survey',
          questions: [] as any[],
        })),
        ...(caseListColumns && { case_list_columns: caseListColumns }),
      }
    }),
  }

  const doneResult = { blueprint, hqJson: {}, success: true }
  stages.push({
    header: 'Done',
    messages: lastMessages,
    applyToBuilder: (b) => b.setDone(doneResult),
  })

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
