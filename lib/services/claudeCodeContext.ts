/**
 * Module-level store for Claude Code conversation context.
 * Used to pass conversation history from ClaudeCodeChat → BuilderLayout
 * so the SA has context about why the app was designed this way.
 */
import type { UIMessage } from 'ai'

let _messages: UIMessage[] | undefined

/** Store Claude Code conversation for the builder to pick up. */
export function setClaudeCodeContext(messages: { role: string; content: string }[]) {
  // Convert simple messages to UIMessage format for useChat initialMessages
  _messages = messages
    .filter(m => m.content.trim()) // skip empty
    .map((m, i) => ({
      id: `cc-${i}`,
      role: m.role as 'user' | 'assistant',
      parts: [{ type: 'text' as const, text: m.content }],
      content: m.content,
    }))
}

/** Get and clear the stored context (consumed once by BuilderLayout). */
export function consumeClaudeCodeContext(): UIMessage[] | undefined {
  const msgs = _messages
  _messages = undefined
  return msgs
}
