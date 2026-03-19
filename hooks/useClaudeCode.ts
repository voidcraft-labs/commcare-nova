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

export interface StatusUpdate {
  phase: string
  message: string
}

export interface ClaudeCodeMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Parsed structured question from a ```question block, if present */
  structuredQuestion?: StructuredQuestion
  /** Parsed status update from a ```status block, if present */
  statusUpdate?: StatusUpdate
  /** If true, this user message was sent by clicking a question card option — hide the bubble */
  fromCard?: boolean
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

/** Extract a status update from a ```status fenced block. */
export function extractStatus(text: string): StatusUpdate | null {
  const match = text.match(/```status\s*\n([\s\S]*?)\n```/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    if (parsed?.phase && parsed?.message) {
      return { phase: parsed.phase, message: parsed.message }
    }
  } catch {
    // invalid JSON
  }
  return null
}

/** Check if an object looks like a complete AppBlueprint (not a partial example). */
function isCompleteBlueprint(obj: any): boolean {
  if (!obj?.app_name || !Array.isArray(obj?.modules) || obj.modules.length === 0) return false
  // Must have at least one module with forms that have questions
  return obj.modules.some((m: any) =>
    Array.isArray(m?.forms) && m.forms.some((f: any) =>
      Array.isArray(f?.questions) && f.questions.length > 0
    )
  )
}

export function extractBlueprint(text: string): any | null {
  const blockRegex = /```json\s*\n([\s\S]*?)\n```/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (isCompleteBlueprint(parsed)) {
        return parsed
      }
    } catch {
      // invalid JSON, skip
    }
  }
  return null
}

type Status = 'ready' | 'streaming' | 'error'

export interface CumulativeUsage {
  inputTokens: number
  outputTokens: number
}

export function useClaudeCode() {
  const [messages, setMessages] = useState<ClaudeCodeMessage[]>([])
  const [status, setStatus] = useState<Status>('ready')
  const [error, setError] = useState<string | null>(null)
  const [blueprint, setBlueprint] = useState<any | null>(null)
  const [usage, setUsage] = useState<CumulativeUsage>({ inputTokens: 0, outputTokens: 0 })
  const [elapsedMs, setElapsedMs] = useState(0)

  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(0)

  const sendMessage = useCallback(async (text: string, opts?: { fromCard?: boolean }) => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller

    // Start elapsed time timer
    startTimeRef.current = Date.now()
    setElapsedMs(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current)
    }, 500)

    const userMessage: ClaudeCodeMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      fromCard: opts?.fromCard,
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
    let sawFileWrite = false  // Track if Claude Code used Write tool (wrote blueprint file)

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
              // Check for structured question or status blocks
              const sq = extractQuestion(fullText)
              const su = extractStatus(fullText)
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId
                    ? { ...m, content: fullText, structuredQuestion: sq ?? undefined, statusUpdate: su ?? undefined }
                    : m
                )
              )
            } else if (currentEvent === 'usage') {
              const u = data?.usage
              if (u) {
                setUsage(prev => ({
                  inputTokens: prev.inputTokens + (u.inputTokens ?? 0),
                  outputTokens: prev.outputTokens + (u.outputTokens ?? 0),
                }))
              }
            } else if (currentEvent === 'tool_use') {
              const tool = typeof data === 'string' ? data : (data?.tool ?? data?.name ?? 'tool')
              if (tool === 'Write') sawFileWrite = true
              // Don't append tool_use text inline — it creates artifacts
            } else if (currentEvent === 'result') {
              // Stop the timer
              if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
              setElapsedMs(Date.now() - startTimeRef.current)

              // Extract usage from result (parser includes it with accurate totals)
              if (data?.usage) {
                setUsage(prev => ({
                  inputTokens: prev.inputTokens + (data.usage.inputTokens ?? 0),
                  outputTokens: prev.outputTokens + (data.usage.outputTokens ?? 0),
                }))
              }

              // Only look for blueprint in text if the response looks like it was a generation turn
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

      // Only check the file endpoint if Claude Code used the Write tool
      // (meaning it wrote .nova/blueprint.json) and we didn't find it in text
      if (!foundBlueprint && sawFileWrite) {
        try {
          const bpRes = await fetch('/api/claude-code/blueprint', { signal: controller.signal })
          if (bpRes.ok) {
            const bpData = await bpRes.json()
            if (bpData?.blueprint && isCompleteBlueprint(bpData.blueprint)) {
              setBlueprint(bpData.blueprint)
            }
          }
        } catch (bpErr: any) {
          if (bpErr?.name === 'AbortError') return
        }
      }
    } catch (err: any) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
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
    usage,
    elapsedMs,
  }
}
