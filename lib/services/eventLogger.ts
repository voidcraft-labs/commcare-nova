/**
 * EventLogger — flat event stream logger with pluggable sinks.
 *
 * A log is a flat, ordered stream of events. The storage backend is a
 * transport concern, not a schema concern. Every event is a self-describing
 * StoredEvent — one object that writes identically to both sinks.
 *
 * **File sink** (EVENT_LOGGER=1): writes one JSONL line per event to
 * `.log/{runId}.jsonl`. Each line is a complete, self-contained event.
 * If the process crashes mid-generation, every previous event is intact.
 *
 * **Firestore sink** (enableFirestore): writes one document per event to
 * `users/{email}/projects/{projectId}/logs/`. Fire-and-forget — a Firestore
 * outage never blocks generation.
 *
 * Both sinks receive the same StoredEvent object. No conversion, no sparse
 * stripping, no format bridging.
 */
import type { UIMessage } from 'ai'
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { MODEL_PRICING, DEFAULT_PRICING } from '../models'
import type { ClassifiedError } from './errorClassifier'
import type { StoredEvent, LogEvent, LogToolCall, TokenUsage, JsonValue } from '../db/types'
import { parseJsonlEvents } from '../db/jsonl'
import { writeLogEvent } from '../db/logs'

// ── Constants ───────────────────────────────────────────────────────

const SKIP_EMISSIONS = new Set(['data-partial-scaffold', 'data-run-id'])
const LOG_DIR = path.join(process.cwd(), '.log')

// ── EventLogger ─────────────────────────────────────────────────────

export class EventLogger {
  private _runId: string
  private filePath: string | null
  private fileEnabled: boolean

  /* Firestore sink */
  private fsEmail: string | null = null
  private fsProjectId: string | null = null

  /* Ordering */
  private sequence = 0
  private requestNumber = 0
  private stepIndex = 0

  /* Buffered data matched into the next step event by logStep() */
  private pendingSubResults: Array<{ label: string; usage: TokenUsage; reasoning: string }> = []
  private pendingToolOutputs: Array<{ toolName: string; output: JsonValue }> = []

  constructor(existingRunId?: string) {
    this._runId = existingRunId ?? crypto.randomUUID()
    this.fileEnabled = process.env.EVENT_LOGGER === '1'

    if (this.fileEnabled) {
      mkdirSync(LOG_DIR, { recursive: true })
      this.filePath = path.join(LOG_DIR, `${this._runId}.jsonl`)

      /* Resume from existing file — count existing lines to restore sequence/step/request */
      if (existingRunId && existsSync(this.filePath)) {
        try {
          const events = parseJsonlEvents(readFileSync(this.filePath, 'utf-8'))
          for (const evt of events) {
            this.sequence = Math.max(this.sequence, evt.sequence + 1)
            this.requestNumber = Math.max(this.requestNumber, evt.request + 1)
            if (evt.event.type === 'step') {
              this.stepIndex = Math.max(this.stepIndex, evt.event.step_index + 1)
            }
          }
        } catch { /* corrupt file — start fresh counters */ }
      }
    } else {
      this.filePath = null
    }
  }

  get runId(): string { return this._runId }

  /**
   * Enable real-time Firestore logging. Each emit/logStep/logError/logMessage
   * call writes a document to `users/{email}/projects/{projectId}/logs/`.
   */
  enableFirestore(email: string, projectId: string) {
    this.fsEmail = email
    this.fsProjectId = projectId
  }

  private get firestoreEnabled(): boolean {
    return this.fsEmail !== null && this.fsProjectId !== null
  }

  private get anyEnabled(): boolean {
    return this.fileEnabled || this.firestoreEnabled
  }

  // ── Core: write a StoredEvent to all active sinks ──────────────

  private write(event: LogEvent) {
    const stored: StoredEvent = {
      run_id: this._runId,
      sequence: this.sequence++,
      request: this.requestNumber,
      timestamp: new Date().toISOString(),
      event,
    }

    if (this.fileEnabled && this.filePath) {
      appendFileSync(this.filePath, JSON.stringify(stored) + '\n')
    }

    if (this.firestoreEnabled) {
      writeLogEvent(this.fsEmail!, this.fsProjectId!, stored)
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Log user messages from the current request. Extracts user-role messages
   * and writes one message event per user message in the current request.
   */
  logConversation(messages: UIMessage[]) {
    if (!this.anyEnabled) return

    const userMessages = messages
      .filter(m => m.role === 'user')
      .map(m => ({
        id: m.id,
        text: m.parts
          .filter((p: { type: string }) => p.type === 'text')
          .map((p: { type: string; text?: string }) => p.text ?? '')
          .join('\n'),
      }))

    /* Write only the current request's user message — previous messages were
     * written by previous requests. */
    const currentMsg = userMessages[this.requestNumber]
    if (currentMsg) {
      this.write({ type: 'message', id: currentMsg.id, text: currentMsg.text })
    }
  }

  /** Buffer a server-side tool output to be matched into the next logStep. */
  logToolOutput(toolName: string, output: JsonValue) {
    if (!this.anyEnabled) return
    this.pendingToolOutputs.push({ toolName, output: structuredClone(output) as JsonValue })
  }

  /** Write an emission event immediately (real-time, not batched). */
  logEmission(type: string, data: unknown) {
    if (!this.anyEnabled) return
    if (SKIP_EMISSIONS.has(type)) return

    this.write({
      type: 'emission',
      step_index: this.stepIndex,
      emission_type: type,
      emission_data: structuredClone(data) as JsonValue,
    })
  }

  /** Write an error event immediately. */
  logError(error: ClassifiedError, context?: string) {
    if (!this.anyEnabled) return
    this.write({
      type: 'error',
      error_type: error.type,
      error_message: error.message,
      error_raw: error.raw ?? '',
      error_fatal: !error.recoverable,
      error_context: context ?? '',
    })
  }

  /** Buffer a sub-generation result to be matched into the next logStep. */
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
    if (!this.anyEnabled) return
    this.pendingSubResults.push({
      label,
      usage: {
        model: result.model,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cache_read_tokens: result.cache_read_tokens ?? 0,
        cache_write_tokens: result.cache_write_tokens ?? 0,
        cost: estimateCost(
          result.model, result.input_tokens, result.output_tokens,
          result.cache_read_tokens, result.cache_write_tokens,
        ),
      },
      reasoning: result.reasoningText ?? '',
    })
  }

  /**
   * Write a step event for a completed agent turn. Drains buffered sub-results
   * and tool outputs, matches them to tool calls by name, computes cost.
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
    if (!this.anyEnabled) return

    /* Match tool calls to buffered sub-results and outputs */
    const toolCalls: LogToolCall[] = (step.tool_calls ?? []).map(tc => {
      const subIdx = this.pendingSubResults.findIndex(sr => labelMatchesToolName(sr.label, tc.name))
      const subResult = subIdx >= 0 ? this.pendingSubResults.splice(subIdx, 1)[0] : undefined
      const outIdx = this.pendingToolOutputs.findIndex(to => to.toolName === tc.name)
      const toolOutput = outIdx >= 0 ? this.pendingToolOutputs.splice(outIdx, 1)[0] : undefined
      return {
        name: tc.name,
        args: tc.args as JsonValue,
        output: toolOutput?.output ?? null,
        generation: subResult?.usage ?? null,
        reasoning: subResult?.reasoning ?? '',
      }
    })

    this.pendingSubResults = []
    this.pendingToolOutputs = []

    const usage: TokenUsage = {
      model: step.usage.model,
      input_tokens: step.usage.input_tokens,
      output_tokens: step.usage.output_tokens,
      cache_read_tokens: step.usage.cache_read_tokens ?? 0,
      cache_write_tokens: step.usage.cache_write_tokens ?? 0,
      cost: estimateCost(
        step.usage.model, step.usage.input_tokens, step.usage.output_tokens,
        step.usage.cache_read_tokens, step.usage.cache_write_tokens,
      ),
    }

    this.write({
      type: 'step',
      step_index: this.stepIndex,
      text: step.text ?? '',
      reasoning: step.reasoning ?? '',
      tool_calls: toolCalls,
      usage,
    })

    this.stepIndex++
  }

  /**
   * No-op. JSONL files are always in a valid state — each line is a complete
   * event, so there's nothing to finalize.
   */
  finalize() {}
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Estimate USD cost from token counts using MODEL_PRICING. */
export function estimateCost(
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

/** Match sub-result labels to tool names for step grouping. */
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
