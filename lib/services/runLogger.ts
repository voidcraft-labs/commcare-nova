/**
 * RunLogger — disk-based run logger that writes one JSON file per run to .log/.
 *
 * Writes valid JSON to disk after every mutation so the log is always inspectable,
 * even if the process crashes mid-run. Orchestration events from agent onStepFinish
 * callbacks carry tool_calls; sub-generation results from ctx.generate()/streamGenerate()
 * are stitched onto matching tool calls via logSubResult().
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

export interface RunLog {
  version: 1
  run_id: string
  app_name: string | null
  started_at: string
  finished_at: string | null
  total_input_tokens: number
  total_output_tokens: number
  total_cost_estimate: number
  conversation: UIMessage[]
  events: RunEvent[]
}

export interface RunEvent {
  index: number
  timestamp: string
  type: 'orchestration' | 'generation' | 'fix'
  agent: string
  label: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost_estimate: number
  knowledge?: string[]
  input?: { system: string; message: unknown; tools?: unknown }
  output?: unknown
  tool_calls?: Array<{
    name: string
    args: unknown
    result?: unknown
  }>
}

// ── RunLogger ───────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), '.log')
const UUID_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

export class RunLogger {
  private log: RunLog
  private filePath: string
  private enabled: boolean
  private currentAgent: string = 'unknown'

  /**
   * @param existingRunId — if provided, resumes an existing log file at .log/{runId}.json
   */
  constructor(existingRunId?: string) {
    this.enabled = process.env.RUN_LOGGER === '1'

    // Fire-and-forget: rename any orphaned UUID log files from abandoned runs
    if (this.enabled) {
      RunLogger.cleanupAbandonedLogs(existingRunId).catch(() => {})
    }

    // Try to resume from an existing run
    if (this.enabled && existingRunId) {
      const activePath = path.join(LOG_DIR, `${existingRunId}.json`)
      if (existsSync(activePath)) {
        const raw = readFileSync(activePath, 'utf-8')
        this.log = JSON.parse(raw) as RunLog
        this.log.finished_at = null
        this.filePath = activePath
        return
      }
    }

    // Fresh run
    const runId = existingRunId ?? crypto.randomUUID()
    this.log = {
      version: 1,
      run_id: runId,
      app_name: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_estimate: 0,
      conversation: [],
      events: [],
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

  setAgent(agent: string) {
    this.currentAgent = agent
  }

  /**
   * Update the conversation log with the latest messages from the client.
   * Called at the start of each request — overwrites with the latest (most complete)
   * messages array so the log always has the full conversation history.
   */
  logConversation(messages: UIMessage[]) {
    this.log.conversation = messages
    if (this.enabled) this.flush()
  }

  logEvent(event: Omit<RunEvent, 'index' | 'timestamp' | 'cost_estimate'>) {
    this.log.events.push({
      ...event,
      index: this.log.events.length,
      timestamp: new Date().toISOString(),
      cost_estimate: estimateCost(event.model, event.input_tokens, event.output_tokens, event.cache_read_tokens, event.cache_write_tokens),
    })
    if (this.enabled) this.flush()
  }

  /**
   * Stitch a sub-generation result onto the most recent orchestration event's
   * matching tool call. If no match is found, log as a standalone generation event.
   */
  logSubResult(
    label: string,
    result: {
      model: string
      input_tokens: number
      output_tokens: number
      input?: { system: string; message: unknown }
      output?: unknown
      reasoningText?: string
      knowledge?: string[]
    },
  ) {
    // Search backwards for an orchestration event with a tool call whose
    // name matches the label pattern
    for (let i = this.log.events.length - 1; i >= 0; i--) {
      const event = this.log.events[i]
      if (event.type !== 'orchestration' || !event.tool_calls) continue

      for (const tc of event.tool_calls) {
        if (tc.result != null) continue

        if (toolCallMatchesLabel(tc.name, label)) {
          tc.result = {
            model: result.model,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            cost_estimate: estimateCost(result.model, result.input_tokens, result.output_tokens),
            input: result.input,
            output: result.output,
            ...(result.reasoningText && { reasoningText: result.reasoningText }),
            ...(result.knowledge && { knowledge: result.knowledge }),
          }
          if (this.enabled) this.flush()
          return
        }
      }
    }

    // No matching orchestration event found — log as standalone
    this.logEvent({
      type: 'generation',
      agent: this.currentAgent,
      label,
      model: result.model,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      input: result.input,
      output: result.output,
      ...(result.reasoningText && { reasoningText: result.reasoningText }),
      ...(result.knowledge && { knowledge: result.knowledge }),
    })
  }

  finalize() {
    this.log.finished_at = new Date().toISOString()
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

  private recomputeTotals() {
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    for (const event of this.log.events) {
      totalInput += event.input_tokens
      totalOutput += event.output_tokens
      totalCost += event.cost_estimate

      if (event.tool_calls) {
        for (const tc of event.tool_calls) {
          if (tc.result && typeof tc.result === 'object' && 'input_tokens' in tc.result) {
            const r = tc.result as { input_tokens: number; output_tokens: number; cost_estimate: number }
            totalInput += r.input_tokens
            totalOutput += r.output_tokens
            totalCost += r.cost_estimate
          }
        }
      }
    }

    this.log.total_input_tokens = totalInput
    this.log.total_output_tokens = totalOutput
    this.log.total_cost_estimate = Math.round(totalCost * 10000) / 10000
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

/** Check if a tool call name matches a generation label. */
function toolCallMatchesLabel(toolName: string, label: string): boolean {
  const l = label.toLowerCase()

  switch (toolName) {
    case 'generateScaffold': return l.startsWith('scaffold')
    case 'generateModuleContent': return l.startsWith('module')
    case 'generateFormContent': return l.startsWith('form')
    case 'regenerateForm': return l.startsWith('regenerate')
    case 'validateApp': return l.startsWith('fixer')
    default: return false
  }
}
