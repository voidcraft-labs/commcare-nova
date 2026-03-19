'use client'

import { useState, useRef, useCallback } from 'react'

export interface QuestionOption {
  label: string
  description?: string
}

export interface StructuredQuestion {
  header: string
  question: string
  options: QuestionOption[]
}

export interface ClaudeCodeMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Parsed structured question from a ```question block, if present */
  structuredQuestion?: StructuredQuestion
}

/** Extract a structured question from a ```question fenced block. */
export function extractQuestion(text: string): StructuredQuestion | null {
  const match = text.match(/```question\s*\n([\s\S]*?)\n```/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    if (parsed?.question && Array.isArray(parsed?.options) && parsed.options.length >= 2) {
      return {
        header: parsed.header ?? '',
        question: parsed.question,
        options: parsed.options.map((o: any) =>
          typeof o === 'string' ? { label: o } : { label: o.label, description: o.description }
        ),
      }
    }
  } catch {
    // invalid JSON
  }
  return null
}

/** Get the text content before a ```question block (context sentence). */
export function getQuestionPreamble(text: string): string {
  const idx = text.indexOf('```question')
  if (idx <= 0) return ''
  return text.slice(0, idx).trim()
}

export function extractBlueprint(text: string): any | null {
  const blockRegex = /```json\n([\s\S]*?)\n```/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed === 'object' && 'app_name' in parsed && Array.isArray(parsed.modules)) {
        return parsed
      }
    } catch {
      // invalid JSON, skip
    }
  }
  return null
}

type Status = 'ready' | 'streaming' | 'error'

export function useClaudeCode() {
  const [messages, setMessages] = useState<ClaudeCodeMessage[]>([])
  const [status, setStatus] = useState<Status>('ready')
  const [error, setError] = useState<string | null>(null)
  const [blueprint, setBlueprint] = useState<any | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (text: string) => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller

    const userMessage: ClaudeCodeMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    }
    const assistantMessage: ClaudeCodeMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
    }

    setMessages(prev => [...prev, userMessage, assistantMessage])
    setStatus('streaming')
    setError(null)

    const assistantId = assistantMessage.id
    let fullText = ''
    let foundBlueprint = false

    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, sessionId: sessionIdRef.current }),
        signal: controller.signal,
      })

      if (!response.body) {
        throw new Error('No response body')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? ''

        let currentEvent = ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:')) {
            const dataStr = line.slice('data:'.length).trim()
            let data: any
            try {
              data = JSON.parse(dataStr)
            } catch {
              data = dataStr
            }

            if (currentEvent === 'init') {
              if (data && typeof data === 'object' && data.sessionId) {
                sessionIdRef.current = data.sessionId
              }
            } else if (currentEvent === 'text') {
              const chunk = typeof data === 'string' ? data : (data?.text ?? '')
              fullText += chunk
              // Check for a complete structured question block
              const sq = extractQuestion(fullText)
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId ? { ...m, content: fullText, structuredQuestion: sq ?? undefined } : m
                )
              )
            } else if (currentEvent === 'tool_use') {
              const tool = typeof data === 'string' ? data : (data?.tool ?? data?.name ?? 'tool')
              fullText += `\n*Using ${tool}...*\n`
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId ? { ...m, content: fullText } : m
                )
              )
            } else if (currentEvent === 'result') {
              const bp = extractBlueprint(fullText)
              if (bp) {
                foundBlueprint = true
                setBlueprint(bp)
              }
            } else if (currentEvent === 'error') {
              const msg = typeof data === 'string' ? data : (data?.message ?? 'Unknown error')
              setError(msg)
              setStatus('error')
            }

            currentEvent = ''
          }
        }
      }

      setStatus('ready')

      if (!foundBlueprint) {
        try {
          const bpRes = await fetch('/api/claude-code/blueprint', { signal: controller.signal })
          if (bpRes.ok) {
            const bpData = await bpRes.json()
            if (bpData) {
              setBlueprint(bpData)
            }
          }
        } catch (bpErr: any) {
          if (bpErr?.name === 'AbortError') return
          // Non-fatal: blueprint fetch failed, ignore
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setError(err?.message ?? 'Unknown error')
      setStatus('error')
    }
  }, [])

  return {
    messages,
    status,
    error,
    sendMessage,
    blueprint,
    sessionId: sessionIdRef.current,
  }
}
