/**
 * RunLogger — disk-based run logger that writes one JSON file per run to .log/.
 *
 * v3 format: each "turn" is one LLM call — grouped with its programmatic sub-calls
 * (from code_execution), emissions, and cost. Emissions carry full payloads for
 * deterministic builder replay; `events` provides human-readable summaries.
 *
 * User messages stored as plain text. No conversation duplication.
 *
 * Persistence across requests: the log file is `.log/{runId}.json` while active.
 * The client sends back the `runId` from previous requests, so the RunLogger can
 * load the existing file and append to it. On finalize(), the file is renamed to
 * `.log/{timestamp}_{appname}.json` for human-readable browsing.
 *
 * Enabled by setting RUN_LOGGER=1 in .env. When disabled, all methods are no-ops.
 */
import type { UIMessage } from 'ai'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { readdir, readFile, rename as renameAsync } from 'fs/promises'
import path from 'path'
import { MODEL_PRICING, DEFAULT_PRICING } from '../models'

// ── Types ───────────────────────────────────────────────────────────────

export interface Emission {
  type: string
  data: unknown
}

export interface StepUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost_estimate: number
}

export interface SubCall {
  name: string
  args: unknown
  output?: unknown
}

export interface TurnToolCall {
  name: string
  args: unknown
  output?: unknown
  generation?: StepUsage
  reasoning?: string
  sub_calls?: SubCall[]
}

export interface Turn {
  index: number
  timestamp: string
  request: number
  usage: StepUsage
  reasoning?: string
  text?: string
  tool_calls?: TurnToolCall[]
  events: string[]
  emissions: Emission[]
}

export interface RunLog {
  version: 3
  run_id: string
  app_name: string | null
  started_at: string
  finished_at: string | null
  totals: {
    input_tokens: number
    output_tokens: number
    cost_estimate: number
  }
  user_messages: Array<{ id: string; text: string }>
  turns: Turn[]
}

// ── Internal types ──────────────────────────────────────────────────────

/** Intermediate: a tool call with matched sub-results and outputs, before turn grouping. */
interface MatchedToolCall {
  name: string
  args: unknown
  output?: unknown
  generation?: StepUsage
  reasoning?: string
}

// ── Constants ───────────────────────────────────────────────────────────

const SKIP_EMISSIONS = new Set(['data-partial-scaffold', 'data-run-id'])
const LOG_DIR = path.join(process.cwd(), '.log')
const UUID_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

// ── RunLogger ───────────────────────────────────────────────────────────

export class RunLogger {
  private log: RunLog
  private filePath: string
  private enabled: boolean
  private requestNumber = 0
  private pendingEmissions: Emission[] = []
  private pendingSubResults: Array<{ label: string; usage: StepUsage; reasoning?: string }> = []
  private pendingToolOutputs: Array<{ toolName: string; output: {} }> = []

  constructor(existingRunId?: string) {
    this.enabled = process.env.RUN_LOGGER === '1'

    if (this.enabled) {
      RunLogger.cleanupAbandonedLogs(existingRunId).catch(() => {})
    }

    if (this.enabled && existingRunId) {
      const activePath = path.join(LOG_DIR, `${existingRunId}.json`)
      if (existsSync(activePath)) {
        try {
          const raw = readFileSync(activePath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed.version === 3) {
            this.log = parsed as RunLog
            this.log.finished_at = null
            this.filePath = activePath
            if (this.log.turns.length > 0) {
              this.requestNumber = this.log.turns[this.log.turns.length - 1].request + 1
            }
            return
          }
        } catch {}
      }
    }

    const runId = existingRunId ?? crypto.randomUUID()
    this.log = {
      version: 3,
      run_id: runId,
      app_name: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      totals: { input_tokens: 0, output_tokens: 0, cost_estimate: 0 },
      user_messages: [],
      turns: [],
    }
    this.filePath = path.join(LOG_DIR, `${runId}.json`)
  }

  get runId(): string {
    return this.log.run_id
  }

  setAppName(name: string) {
    this.log.app_name = name
    if (this.enabled) this.flush()
  }

  setAgent(_agent: string) {}

  logConversation(messages: UIMessage[]) {
    if (!this.enabled) return
    this.backfillToolOutputs(messages)
    this.log.user_messages = messages
      .filter(m => m.role === 'user')
      .map(m => ({
        id: m.id,
        text: m.parts
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n'),
      }))
    this.flush()
  }

  logToolOutput(toolName: string, output: {}) {
    if (!this.enabled) return
    this.pendingToolOutputs.push({ toolName, output: structuredClone(output) })
  }

  logEmission(type: string, data: unknown) {
    if (!this.enabled) return
    if (SKIP_EMISSIONS.has(type)) return
    this.pendingEmissions.push({ type, data: structuredClone(data) })
  }

  logSubResult(
    label: string,
    result: {
      model: string
      input_tokens: number
      output_tokens: number
      cache_read_tokens?: number
      cache_write_tokens?: number
      input?: unknown
      output?: unknown
      reasoningText?: string
    },
  ) {
    if (!this.enabled) return
    this.pendingSubResults.push({
      label,
      usage: {
        model: result.model,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        ...(result.cache_read_tokens && { cache_read_tokens: result.cache_read_tokens }),
        ...(result.cache_write_tokens && { cache_write_tokens: result.cache_write_tokens }),
        cost_estimate: estimateCost(result.model, result.input_tokens, result.output_tokens, result.cache_read_tokens, result.cache_write_tokens),
      },
      ...(result.reasoningText && { reasoning: result.reasoningText }),
    })
  }

  logStep(step: {
    text?: string
    reasoning?: string
    tool_calls?: Array<{ name: string; args: unknown }>
    usage: {
      model: string
      input_tokens: number
      output_tokens: number
      cache_read_tokens?: number
      cache_write_tokens?: number
    }
  }) {
    if (!this.enabled) return

    const toolCalls: MatchedToolCall[] | undefined = step.tool_calls?.map(tc => {
      const subIdx = this.pendingSubResults.findIndex(sr => labelMatchesToolName(sr.label, tc.name))
      const subResult = subIdx >= 0 ? this.pendingSubResults.splice(subIdx, 1)[0] : undefined
      const outIdx = this.pendingToolOutputs.findIndex(to => to.toolName === tc.name)
      const toolOutput = outIdx >= 0 ? this.pendingToolOutputs.splice(outIdx, 1)[0] : undefined
      return {
        name: tc.name,
        args: tc.args,
        ...(toolOutput && { output: toolOutput.output }),
        ...(subResult && { generation: subResult.usage }),
        ...(subResult?.reasoning && { reasoning: subResult.reasoning }),
      }
    })

    const emissions = [...this.pendingEmissions]
    this.pendingEmissions = []
    this.pendingSubResults = []
    this.pendingToolOutputs = []

    const usage: StepUsage = {
      model: step.usage.model,
      input_tokens: step.usage.input_tokens,
      output_tokens: step.usage.output_tokens,
      ...(step.usage.cache_read_tokens && { cache_read_tokens: step.usage.cache_read_tokens }),
      ...(step.usage.cache_write_tokens && { cache_write_tokens: step.usage.cache_write_tokens }),
      cost_estimate: estimateCost(
        step.usage.model,
        step.usage.input_tokens,
        step.usage.output_tokens,
        step.usage.cache_read_tokens,
        step.usage.cache_write_tokens,
      ),
    }

    const isNewTurn = step.usage.input_tokens > 0 || this.log.turns.length === 0

    if (isNewTurn) {
      this.startNewTurn(
        { text: step.text, reasoning: step.reasoning, usage },
        toolCalls ?? [],
        emissions,
      )
    } else {
      this.appendSubCalls(toolCalls ?? [], emissions)
    }

    this.flush()
  }

  finalize() {
    if (!this.enabled) return
    this.log.finished_at = new Date().toISOString()
    this.recomputeTotals()
    this.flush()
  }

  // ── Private ─────────────────────────────────────────────────────────

  private static async cleanupAbandonedLogs(excludeRunId?: string) {
    try {
      const files = await readdir(LOG_DIR)
      for (const file of files) {
        if (!UUID_FILE_PATTERN.test(file)) continue
        const runId = file.replace('.json', '')
        if (runId === excludeRunId) continue
        try {
          const filePath = path.join(LOG_DIR, file)
          const raw = await readFile(filePath, 'utf-8')
          const log = JSON.parse(raw) as Pick<RunLog, 'started_at' | 'app_name' | 'finished_at'>
          const fallback = log.finished_at ? 'unnamed' : 'abandoned'
          const finalPath = buildFinalPath(log.started_at, log.app_name, fallback)
          await renameAsync(filePath, finalPath)
        } catch {}
      }
    } catch {}
  }

  private startNewTurn(
    step: { text?: string; reasoning?: string; usage: StepUsage },
    toolCalls: MatchedToolCall[],
    emissions: Emission[],
  ) {
    const turn: Turn = {
      index: this.log.turns.length,
      timestamp: new Date().toISOString(),
      request: this.requestNumber,
      usage: step.usage,
      ...(step.text && { text: step.text }),
      ...(step.reasoning && { reasoning: step.reasoning }),
      events: emissions.map(summarizeEmission),
      emissions,
    }

    if (toolCalls.length > 0) {
      const ceIdx = toolCalls.findIndex(tc => tc.name === 'code_execution')
      if (ceIdx >= 0) {
        const ceTc = toolCalls[ceIdx]
        const subCalls: SubCall[] = toolCalls
          .filter((_, i) => i !== ceIdx)
          .map(tc => ({
            name: tc.name,
            args: tc.args,
            ...(tc.output !== undefined && { output: tc.output }),
          }))
        turn.tool_calls = [{
          name: ceTc.name,
          args: ceTc.args,
          ...(ceTc.output !== undefined && { output: ceTc.output }),
          ...(ceTc.generation && { generation: ceTc.generation }),
          ...(ceTc.reasoning && { reasoning: ceTc.reasoning }),
          ...(subCalls.length > 0 && { sub_calls: subCalls }),
        }]
      } else {
        turn.tool_calls = toolCalls.map(tc => ({
          name: tc.name,
          args: tc.args,
          ...(tc.output !== undefined && { output: tc.output }),
          ...(tc.generation && { generation: tc.generation }),
          ...(tc.reasoning && { reasoning: tc.reasoning }),
        }))
      }
    }

    this.log.turns.push(turn)
  }

  private appendSubCalls(toolCalls: MatchedToolCall[], emissions: Emission[]) {
    if (this.log.turns.length === 0) {
      const noopUsage: StepUsage = { model: 'unknown', input_tokens: 0, output_tokens: 0, cost_estimate: 0 }
      this.startNewTurn({ usage: noopUsage }, toolCalls, emissions)
      return
    }

    const currentTurn = this.log.turns[this.log.turns.length - 1]
    const ceTc = currentTurn.tool_calls?.find(tc => tc.name === 'code_execution')

    if (ceTc && toolCalls.length > 0) {
      if (!ceTc.sub_calls) ceTc.sub_calls = []
      for (const tc of toolCalls) {
        ceTc.sub_calls.push({
          name: tc.name,
          args: tc.args,
          ...(tc.output !== undefined && { output: tc.output }),
        })
      }
    }

    currentTurn.events.push(...emissions.map(summarizeEmission))
    currentTurn.emissions.push(...emissions)
  }

  private backfillToolOutputs(messages: UIMessage[]) {
    const outputs: { name: string; output: unknown }[] = []
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const part of msg.parts) {
        if (part.type === 'tool-askQuestions' && part.state === 'output-available') {
          outputs.push({ name: 'askQuestions', output: part.output })
        }
      }
    }
    if (outputs.length === 0) return

    let idx = 0
    for (const turn of this.log.turns) {
      if (!turn.tool_calls || idx >= outputs.length) continue
      for (const tc of turn.tool_calls) {
        if (tc.name === outputs[idx].name) {
          if (tc.output === undefined) tc.output = outputs[idx].output
          idx++
        }
        if (idx >= outputs.length) break
      }
    }
  }

  private recomputeTotals() {
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    for (const turn of this.log.turns) {
      totalInput += turn.usage.input_tokens
      totalOutput += turn.usage.output_tokens
      totalCost += turn.usage.cost_estimate

      if (turn.tool_calls) {
        for (const tc of turn.tool_calls) {
          if (tc.generation) {
            totalInput += tc.generation.input_tokens
            totalOutput += tc.generation.output_tokens
            totalCost += tc.generation.cost_estimate
          }
        }
      }
    }

    this.log.totals = {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_estimate: Math.round(totalCost * 10000) / 10000,
    }
  }

  private flush() {
    mkdirSync(LOG_DIR, { recursive: true })
    this.recomputeTotals()
    writeFileSync(this.filePath, JSON.stringify(this.log, null, 2))
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING
  const uncachedInput = inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)
  return (
    uncachedInput * pricing.input +
    (cacheReadTokens ?? 0) * pricing.cacheRead +
    (cacheWriteTokens ?? 0) * pricing.cacheWrite +
    outputTokens * pricing.output
  ) / 1_000_000
}

function buildFinalPath(startedAt: string, appName: string | null, fallback: string): string {
  const ts = startedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const sanitized = appName
    ? appName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
    : fallback
  return path.join(LOG_DIR, `${ts}_${sanitized}.json`)
}

function labelMatchesToolName(label: string, toolName: string): boolean {
  const prefix = label.split(/[:\s]/)[0].toLowerCase()
  switch (prefix) {
    case 'schema': return toolName === 'generateSchema'
    case 'scaffold': return toolName === 'generateScaffold'
    case 'module': return toolName === 'addModule'
    case 'generate': return toolName === 'addForm'
    case 'fixer': return toolName === 'validateApp'
    default: return false
  }
}

function summarizeEmission(em: Emission): string {
  const base = em.type.replace(/^data-/, '')
  const d = em.data as Record<string, any> | null | undefined
  if (!d || typeof d !== 'object') return base
  if ('phase' in d) return `${base}:${d.phase}`
  if ('moduleIndex' in d && 'formIndex' in d) return `${base}[${d.moduleIndex}:${d.formIndex}]`
  if ('moduleIndex' in d) return `${base}[${d.moduleIndex}]`
  if ('attempt' in d) return `${base}:${d.attempt}`
  return base
}
