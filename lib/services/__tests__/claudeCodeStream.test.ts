import { describe, it, expect } from 'vitest'
import { parseStreamEvent } from '../claudeCodeStream'

describe('parseStreamEvent', () => {
  it('extracts session_id from init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc123',
    })
    const events = parseStreamEvent(line)
    expect(events).toEqual([{ type: 'init', sessionId: 'sess-abc123' }])
  })

  it('extracts text from assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      message: {
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
    })
    const events = parseStreamEvent(line)
    expect(events[0]).toEqual({ type: 'text', text: 'Hello, world!', sessionId: 'sess-abc123' })
  })

  it('extracts text + usage from assistant message with usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      message: {
        content: [{ type: 'text', text: 'Hi' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
      },
    })
    const events = parseStreamEvent(line)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'text', text: 'Hi' })
    expect(events[1]).toMatchObject({ type: 'usage', usage: { inputTokens: 300, outputTokens: 50 } })
  })

  it('extracts tool_use from assistant tool_use content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc123',
      message: {
        content: [{ type: 'tool_use', name: 'bash', id: 'tool-1', input: {} }],
      },
    })
    const events = parseStreamEvent(line)
    expect(events[0]).toEqual({ type: 'tool_use', tool: 'bash', sessionId: 'sess-abc123' })
  })

  it('extracts result from completion', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task completed.',
      session_id: 'sess-abc123',
      duration_ms: 1234,
    })
    const events = parseStreamEvent(line)
    expect(events).toEqual([{
      type: 'result',
      text: 'Task completed.',
      sessionId: 'sess-abc123',
      durationMs: 1234,
    }])
  })

  it('returns empty array for hook/system events that are not init', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_result',
      output: 'some output',
    })
    expect(parseStreamEvent(line)).toEqual([])
  })

  it('returns error for error result with subtype error', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'Something went wrong',
    })
    expect(parseStreamEvent(line)).toEqual([{ type: 'error', message: 'Something went wrong' }])
  })

  it('returns error for result with is_error true', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Execution failed',
    })
    expect(parseStreamEvent(line)).toEqual([{ type: 'error', message: 'Execution failed' }])
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseStreamEvent('not json')).toEqual([])
  })

  it('returns empty array for empty/whitespace lines', () => {
    expect(parseStreamEvent('')).toEqual([])
    expect(parseStreamEvent('   ')).toEqual([])
  })

  it('returns empty array for unknown event types', () => {
    const line = JSON.stringify({ type: 'unknown', data: 'foo' })
    expect(parseStreamEvent(line)).toEqual([])
  })
})
