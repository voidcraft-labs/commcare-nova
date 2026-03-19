import { describe, it, expect } from 'vitest'
import { parseStreamEvent } from '../claudeCodeStream'

describe('parseStreamEvent', () => {
  it('extracts session_id from init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc123',
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({ type: 'init', sessionId: 'sess-abc123' })
  })

  it('extracts text from assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      message: {
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({ type: 'text', text: 'Hello, world!', sessionId: 'sess-abc123' })
  })

  it('extracts tool_use from assistant tool_use content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      message: {
        content: [{ type: 'tool_use', name: 'bash', id: 'tool-1', input: {} }],
      },
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({ type: 'tool_use', tool: 'bash', sessionId: 'sess-abc123' })
  })

  it('extracts result from completion', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task completed.',
      session_id: 'sess-abc123',
      duration_ms: 1234,
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({
      type: 'result',
      text: 'Task completed.',
      sessionId: 'sess-abc123',
      durationMs: 1234,
    })
  })

  it('returns null for hook/system events that are not init', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_result',
      output: 'some output',
    })
    const event = parseStreamEvent(line)
    expect(event).toBeNull()
  })

  it('returns error for error result with subtype error', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'Something went wrong',
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({ type: 'error', message: 'Something went wrong' })
  })

  it('returns error for result with is_error true', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Execution failed',
    })
    const event = parseStreamEvent(line)
    expect(event).toEqual({ type: 'error', message: 'Execution failed' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseStreamEvent('not json')).toBeNull()
  })

  it('returns null for empty/whitespace lines', () => {
    expect(parseStreamEvent('')).toBeNull()
    expect(parseStreamEvent('   ')).toBeNull()
  })

  it('returns null for unknown event types', () => {
    const line = JSON.stringify({ type: 'unknown', data: 'foo' })
    expect(parseStreamEvent(line)).toBeNull()
  })
})
