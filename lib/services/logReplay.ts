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
import type { Scaffold, BlueprintForm, ModuleContent } from '@/lib/schemas/blueprint'
import { assembleBlueprint } from '@/lib/schemas/blueprint'
import { processContentOutput, type AppContentOutput } from '@/lib/schemas/appContentSchema'

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

/** Search for a generation output in RunLog events by label prefix. */
function findOutput(events: RunEvent[], labelPrefix: string): unknown | null {
  // First: check standalone generation events
  for (const event of events) {
    if (event.type === 'generation' && event.label.toLowerCase().startsWith(labelPrefix.toLowerCase())) {
      if (event.output != null) return event.output
    }
  }

  // Fallback: check tool_call results on orchestration events
  for (const event of events) {
    if (event.type !== 'orchestration' || !event.tool_calls) continue
    for (const tc of event.tool_calls) {
      if (tc.result == null || typeof tc.result !== 'object') continue
      if (toolCallMatchesLabel(tc.name, labelPrefix)) {
        const r = tc.result as Record<string, unknown>
        if (r.output != null) return r.output
      }
    }
  }

  return null
}

/** Mirror of the toolCallMatchesLabel from runLogger.ts (client-side copy). */
function toolCallMatchesLabel(toolName: string, labelPrefix: string): boolean {
  const l = labelPrefix.toLowerCase()
  switch (toolName) {
    case 'generateScaffold': return l.startsWith('scaffold')
    case 'generateModuleContent': return l.startsWith('module')
    case 'generateFormContent': return l.startsWith('form')
    case 'generateAppContent': return l.startsWith('app content')
    case 'regenerateForm': return l.startsWith('regenerate')
    case 'validateApp': return l.startsWith('fixer')
    default: return false
  }
}

/**
 * Extract ordered replay stages from a RunLog.
 *
 * Each stage carries cumulative messages and a builder-apply closure.
 * Conversation stages have a no-op applyToBuilder; generation stages
 * carry forward the last conversation's messages.
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
  // Trailing user messages with no assistant reply
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

  stages.push({
    header: 'Scaffold',
    messages: lastMessages,
    applyToBuilder: (b) => {
      b.setScaffold(scaffold)
      b.setPhase('forms')
    },
  })

  // ── App content ───────────────────────────────────────────────────
  const contentRaw = findOutput(events, 'app content')

  if (contentRaw) {
    const content = contentRaw as AppContentOutput
    let processed: { moduleContents: ModuleContent[]; formContents: BlueprintForm[][] }

    try {
      processed = processContentOutput(content, scaffold)
    } catch (err) {
      return { success: false, error: `Failed to process app content: ${err instanceof Error ? err.message : String(err)}` }
    }

    const { moduleContents, formContents } = processed

    // Module column stages
    for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
      const mc = moduleContents[mIdx]
      if (mc?.case_list_columns) {
        const columns = mc.case_list_columns
        stages.push({
          header: scaffold.modules[mIdx].name,
          subtitle: 'Columns',
          messages: lastMessages,
          applyToBuilder: (b) => b.setModuleContent(mIdx, columns),
        })
      }
    }

    // Form stages
    for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
      const forms = formContents[mIdx] ?? []
      for (let fIdx = 0; fIdx < forms.length; fIdx++) {
        const form = forms[fIdx]
        if (!form) continue
        stages.push({
          header: scaffold.modules[mIdx].name,
          subtitle: form.name,
          messages: lastMessages,
          applyToBuilder: (b) => b.setFormContent(mIdx, fIdx, form),
        })
      }
    }

    // Done stage
    try {
      const blueprint = assembleBlueprint(scaffold, moduleContents, formContents)
      const doneResult = { blueprint, hqJson: {}, success: true }
      stages.push({
        header: 'Done',
        messages: lastMessages,
        applyToBuilder: (b) => b.setDone(doneResult),
      })
    } catch (err) {
      return { success: false, error: `Failed to assemble blueprint: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    // Partial log — scaffold only
    const moduleContents = scaffold.modules.map(() => ({
      case_list_columns: null,
      case_detail_columns: null,
    }))
    const formContents = scaffold.modules.map(m =>
      m.forms.map(f => ({
        name: f.name,
        type: f.type as 'registration' | 'followup' | 'survey',
        questions: [],
      }))
    )
    const blueprint = assembleBlueprint(scaffold, moduleContents, formContents)
    const doneResult = { blueprint, hqJson: {}, success: true }
    stages.push({
      header: 'Done',
      messages: lastMessages,
      applyToBuilder: (b) => b.setDone(doneResult),
    })
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
