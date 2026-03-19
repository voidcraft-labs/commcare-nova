import { spawn } from 'child_process'
import * as readline from 'readline'

export type ClaudeCodeEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; text: string; sessionId: string }
  | { type: 'tool_use'; tool: string; sessionId: string }
  | { type: 'result'; text: string; sessionId: string; durationMs: number }
  | { type: 'error'; message: string }

/**
 * Parses a single JSON line from `claude --output-format stream-json` output.
 * Returns a normalized ClaudeCodeEvent or null if the line is irrelevant.
 */
export function parseStreamEvent(line: string): ClaudeCodeEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>

  const type = obj['type']

  // System init event
  if (type === 'system' && obj['subtype'] === 'init') {
    const sessionId = obj['session_id']
    if (typeof sessionId === 'string') {
      return { type: 'init', sessionId }
    }
    return null
  }

  // Assistant message
  if (type === 'assistant') {
    const message = obj['message']
    if (typeof message !== 'object' || message === null) return null

    const msg = message as Record<string, unknown>
    const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : ''
    const content = msg['content']
    if (!Array.isArray(content) || content.length === 0) return null

    const first = content[0] as Record<string, unknown>
    if (typeof first !== 'object' || first === null) return null

    const contentType = first['type']

    if (contentType === 'text') {
      const text = first['text']
      if (typeof text === 'string') {
        return { type: 'text', text, sessionId }
      }
    }

    if (contentType === 'tool_use') {
      const name = first['name']
      if (typeof name === 'string') {
        return { type: 'tool_use', tool: name, sessionId }
      }
    }

    return null
  }

  // Result event
  if (type === 'result') {
    const subtype = obj['subtype']
    const isError = obj['is_error']

    if (subtype === 'error' || isError === true) {
      const message =
        typeof obj['result'] === 'string'
          ? obj['result']
          : typeof obj['error'] === 'string'
            ? obj['error']
            : 'Unknown error'
      return { type: 'error', message }
    }

    if (subtype === 'success') {
      const result = obj['result']
      const sessionId = obj['session_id']
      const durationMs = obj['duration_ms']
      if (
        typeof result === 'string' &&
        typeof sessionId === 'string' &&
        typeof durationMs === 'number'
      ) {
        return { type: 'result', text: result, sessionId, durationMs }
      }
    }

    return null
  }

  return null
}

export interface StreamClaudeCodeOptions {
  sessionId?: string
  signal?: AbortSignal
}

/**
 * Async generator that spawns `claude` CLI with `--output-format stream-json`
 * and yields parsed ClaudeCodeEvent values as they arrive.
 */
export async function* streamClaudeCode(
  prompt: string,
  opts: StreamClaudeCodeOptions = {},
): AsyncGenerator<ClaudeCodeEvent> {
  const { sessionId, signal } = opts

  const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose']

  if (sessionId) {
    args.push('--resume', sessionId)
  } else {
    args.push('--no-session-persistence')
  }

  const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  const abortHandler = () => {
    proc.kill()
  }

  if (signal) {
    if (signal.aborted) {
      proc.kill()
    } else {
      signal.addEventListener('abort', abortHandler)
    }
  }

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

  const queue: ClaudeCodeEvent[] = []
  let resolve: (() => void) | null = null
  let done = false

  rl.on('line', (line: string) => {
    if (!line.trim()) return
    const event = parseStreamEvent(line)
    if (event !== null) {
      queue.push(event)
      resolve?.()
      resolve = null
    }
  })

  const closePromise = new Promise<void>((res) => {
    proc.on('close', () => {
      done = true
      resolve?.()
      resolve = null
      res()
    })
  })

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (done) break
      await new Promise<void>((res) => {
        resolve = res
      })
    }
    // Drain any remaining events pushed right before done was set
    while (queue.length > 0) {
      yield queue.shift()!
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortHandler)
    }
    if (!proc.killed) {
      proc.kill()
    }
    await closePromise
  }
}
