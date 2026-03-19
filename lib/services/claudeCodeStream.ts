import { spawn } from 'child_process'
import * as readline from 'readline'
import { readFileSync, mkdirSync } from 'fs'
import { join } from 'path'

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

/** Load the nova-generate skill content for use as system prompt.
 *  In dev mode, re-reads the file each time to pick up changes without restart.
 */
let _skillContent: string | undefined
function getSkillSystemPrompt(): string {
  const isDev = process.env.NODE_ENV === 'development'
  if (!_skillContent || isDev) {
    const skillPath = join(process.cwd(), '.claude', 'skills', 'nova-generate.md')
    const raw = readFileSync(skillPath, 'utf-8')
    // Strip frontmatter (--- ... ---)
    _skillContent = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
  }
  return _skillContent
}

/**
 * Async generator that spawns `claude` CLI with `--output-format stream-json`
 * and yields parsed ClaudeCodeEvent values as they arrive.
 *
 * Disables all skills/plugins to prevent superpowers from hijacking the conversation.
 * Injects the nova-generate skill content directly as the system prompt.
 * Restricts tools to Write (for blueprint file) and Read (for codebase context).
 */
export async function* streamClaudeCode(
  prompt: string,
  opts: StreamClaudeCodeOptions = {},
): AsyncGenerator<ClaudeCodeEvent> {
  const { sessionId, signal } = opts

  const systemPrompt = getSkillSystemPrompt()

  const args: string[] = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
    '--tools', 'Write',
    '--permission-mode', 'bypassPermissions',
    '--setting-sources', 'user',
  ]

  if (sessionId) {
    args.push('--resume', sessionId)
  }
  // Note: we do NOT use --no-session-persistence because multi-turn
  // requires the session to be saved so --resume works on follow-up messages.

  // Ensure .nova/ directory exists for blueprint file writes
  mkdirSync(join(process.cwd(), '.nova'), { recursive: true })

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
