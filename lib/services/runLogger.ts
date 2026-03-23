/**
 * RunLogger — disk-based run logger that writes one JSON file per run to .log/.
 *
 * v2 format: each step is one SA agent step — self-contained with its text,
 * tool calls, emissions, and cost. Emissions capture ctx.emit() calls during
 * tool execution, enabling replay by simply calling the same builder methods.
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

export interface StepToolCall {
  name: string
  args: unknown
  output?: unknown
  generation?: StepUsage
  reasoning?: string
}

export interface Step {
  index: number
  timestamp: string
  request: number
  text?: string
  reasoning?: string
  tool_calls?: StepToolCall[]
  emissions: Emission[]
  usage: StepUsage
}

export interface RunLog {
  version: 2
  run_id: string
  app_name: string | null
  started_at: string
  finished_at: string | null
  totals: {
    input_tokens: number
    output_tokens: number
    cost_estimate: number
  }
  conversation: UIMessage[]
  steps: Step[]
}

// ── Transient emissions to skip ─────────────────────────────────────────

const SKIP_EMISSIONS = new Set(['data-partial-scaffold', 'data-run-id'])

// ── RunLogger ───────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), '.log')
const UUID_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

export class RunLogger {
  private log: RunLog
  private filePath: string
  private enabled: boolean
  private requestNumber = 0
  private pendingEmissions: Emission[] = []
  private pendingSubResults: Array<{ label: string; usage: StepUsage; reasoning?: string }> = []
  private pendingToolOutputs: Array<{ toolName: string; output: NonNullable<StepToolCall['output']> }> = []

  /**
   * @param existingRunId — if provided, resumes an existing log file at .log/{runId}.json
   */
  constructor(existingRunId?: string) {
    this.enabled = process.env.RUN_LOGGER === '1'

    // Fire-and-forget: rename any orphaned UUID log files from abandoned runs
    if (this.enabled) {
      RunLogger.cleanupAbandonedLogs(existingRunId).catch(() => {})
    }

    // Try to resume from an existing v2 run
    if (this.enabled && existingRunId) {
      const activePath = path.join(LOG_DIR, `${existingRunId}.json`)
      if (existsSync(activePath)) {
        try {
          const raw = readFileSync(activePath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed.version === 2) {
            this.log = parsed as RunLog
            this.log.finished_at = null
            this.filePath = activePath
            if (this.log.steps.length > 0) {
              this.requestNumber = this.log.steps[this.log.steps.length - 1].request + 1
            }
            return
          }
        } catch {}
        // v1 or corrupt — fall through to fresh run
      }
    }

    // Fresh run
    const runId = existingRunId ?? crypto.randomUUID()
    this.log = {
      version: 2,
      run_id: runId,
      app_name: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      totals: { input_tokens: 0, output_tokens: 0, cost_estimate: 0 },
      conversation: [],
      steps: [],
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

  setAgent(_agent: string) {
    // No-op in v2 — agent name is implicit (always SA)
  }

  /**
   * Update the conversation log with the latest messages from the client.
   * Called at the start of each request — overwrites with the latest (most complete)
   * messages array so the log always has the full conversation history.
   * Also backfills tool outputs (e.g. askQuestions answers) into step tool_calls,
   * since client-side tools only receive output on the follow-up request.
   */
  logConversation(messages: UIMessage[]) {
    this.backfillToolOutputs(messages)
    this.log.conversation = messages
    if (this.enabled) this.flush()
  }

  /**
   * Buffer a server-side tool's return value during execution.
   * Matched to tool_calls by name and drained by logStep().
   */
  logToolOutput(toolName: string, output: NonNullable<StepToolCall['output']>) {
    this.pendingToolOutputs.push({ toolName, output: structuredClone(output) })
  }

  /**
   * Buffer an emission during tool execution. Drained into the step by logStep().
   * Skips transient streaming artifacts (partial-scaffold, run-id).
   */
  logEmission(type: string, data: unknown) {
    if (SKIP_EMISSIONS.has(type)) return
    this.pendingEmissions.push({ type, data: structuredClone(data) })
  }

  /**
   * Buffer a sub-generation result during tool execution.
   * Matched to tool_calls and drained by logStep().
   */
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

  /**
   * Log a completed agent step. Called from onStepFinish.
   * Drains pending emissions and sub-results into the step.
   */
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
    const toolCalls: StepToolCall[] | undefined = step.tool_calls?.map(tc => {
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

    const newStep: Step = {
      index: this.log.steps.length,
      timestamp: new Date().toISOString(),
      request: this.requestNumber,
      ...(step.text && { text: step.text }),
      ...(step.reasoning && { reasoning: step.reasoning }),
      ...(toolCalls?.length && { tool_calls: toolCalls }),
      emissions: [...this.pendingEmissions],
      usage: {
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
      },
    }

    // Drain buffers
    this.pendingEmissions = []
    this.pendingSubResults = []
    this.pendingToolOutputs = []

    this.log.steps.push(newStep)
    if (this.enabled) this.flush()
  }

  finalize() {
    this.log.finished_at = new Date().toISOString()
    this.rebuildConversation()
    this.recomputeTotals()
    if (!this.enabled) return
    this.flush()
  }

  /**
   * Async fire-and-forget cleanup: renames any UUID-named log files from previous sessions
   * to human-readable names. Runs that completed (finished_at set) get the normal name;
   * truly abandoned runs (no finished_at) get an 'abandoned' suffix.
   */
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

  // ── Private ─────────────────────────────────────────────────────────

  /**
   * Backfill tool outputs from client messages into step tool_calls.
   * Client-side tools (e.g. askQuestions) have no execute — output arrives
   * via addToolOutput on the follow-up request. Match by tool name in order.
   */
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
    for (const step of this.log.steps) {
      if (!step.tool_calls || idx >= outputs.length) continue
      for (const tc of step.tool_calls) {
        if (tc.name === outputs[idx].name) {
          if (tc.output === undefined) tc.output = outputs[idx].output
          idx++
        }
        if (idx >= outputs.length) break
      }
    }
  }

  /**
   * Rebuild conversation to include the assistant response from the current request.
   * Constructs an assistant UIMessage from steps in the current request.
   */
  private rebuildConversation() {
    const currentRequestSteps = this.log.steps.filter(s => s.request === this.requestNumber)
    if (currentRequestSteps.length === 0) return

    const parts: any[] = []
    for (const step of currentRequestSteps) {
      if (step.reasoning) {
        parts.push({ type: 'reasoning', reasoning: step.reasoning })
      }
      if (step.text) {
        parts.push({ type: 'text', text: step.text })
      }
      if (step.tool_calls) {
        for (const tc of step.tool_calls) {
          parts.push({
            type: `tool-${tc.name}`,
            toolCallId: `log-${step.index}-${tc.name}`,
            toolName: tc.name,
            input: tc.args,
            state: 'output-available',
            ...(tc.output !== undefined ? { output: tc.output } : {}),
          })
        }
      }
    }

    if (parts.length > 0) {
      this.log.conversation.push({
        id: `assistant-${this.requestNumber}`,
        role: 'assistant',
        parts,
        content: '',
      } as UIMessage)
    }
  }

  private recomputeTotals() {
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    for (const step of this.log.steps) {
      totalInput += step.usage.input_tokens
      totalOutput += step.usage.output_tokens
      totalCost += step.usage.cost_estimate

      if (step.tool_calls) {
        for (const tc of step.tool_calls) {
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

/** Build the final human-readable log file path from a started_at timestamp and optional app name. */
function buildFinalPath(startedAt: string, appName: string | null, fallback: string): string {
  const ts = startedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const sanitized = appName
    ? appName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
    : fallback
  return path.join(LOG_DIR, `${ts}_${sanitized}.json`)
}

/** Match a sub-generation label to its parent tool call name. */
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
