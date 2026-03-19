'use client'
import { useState, useCallback, useRef } from 'react'
import type { UIMessage } from 'ai'
import { extractBlueprint } from './useClaudeCode'
import type { AppBlueprint } from '@/lib/schemas/blueprint'

/**
 * Hook for editing blueprints via Claude Code CLI.
 * Sends edit requests to /api/claude-code with the current blueprint,
 * detects the modified blueprint in the response, and calls onBlueprintUpdated.
 */
export function useClaudeCodeEdit(opts: {
  sessionId: string | null
  getBlueprint: () => AppBlueprint | undefined
  onBlueprintUpdated: (bp: AppBlueprint) => void
  initialMessages?: UIMessage[]
}) {
  const { sessionId, getBlueprint, onBlueprintUpdated, initialMessages } = opts
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages ?? [])
  const [status, setStatus] = useState<'ready' | 'submitted' | 'streaming' | 'error'>('ready')
  const abortRef = useRef<AbortController | null>(null)
  const msgCounter = useRef(0)

  const sendMessage = useCallback(async ({ text }: { text: string }) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const userMsg: UIMessage = {
      id: `cc-edit-user-${++msgCounter.current}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      content: text,
    }
    const assistantId = `cc-edit-asst-${++msgCounter.current}`
    let fullText = ''
    let sawFileWrite = false

    setMessages(prev => [...prev, userMsg, {
      id: assistantId,
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: '' }],
      content: '',
    }])
    setStatus('streaming')

    try {
      const blueprint = getBlueprint()
      const res = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          sessionId,
          blueprint,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        sseBuffer += decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() ?? ''

        let eventType = ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:') && eventType) {
            const data = JSON.parse(line.slice('data:'.length).trim())

            if (eventType === 'text') {
              fullText += typeof data === 'string' ? data : (data?.text ?? '')
              setMessages(prev =>
                prev.map(m => m.id === assistantId
                  ? { ...m, content: fullText, parts: [{ type: 'text' as const, text: fullText }] }
                  : m
                )
              )
            } else if (eventType === 'tool_use') {
              const tool = typeof data === 'string' ? data : (data?.tool ?? 'tool')
              if (tool === 'Write') sawFileWrite = true
            } else if (eventType === 'result') {
              // Check for updated blueprint in text
              const bp = extractBlueprint(fullText)
              if (bp) {
                onBlueprintUpdated(bp)
              } else if (sawFileWrite) {
                // Try fetching from file
                try {
                  const bpRes = await fetch('/api/claude-code/blueprint')
                  if (bpRes.ok) {
                    const bpData = await bpRes.json()
                    if (bpData?.blueprint) onBlueprintUpdated(bpData.blueprint)
                  }
                } catch { /* non-fatal */ }
              }
            }
            eventType = ''
          }
        }
      }

      setStatus('ready')
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setStatus('error')
    }
  }, [sessionId, getBlueprint, onBlueprintUpdated])

  // No-op addToolOutput — CC mode doesn't use tool cards
  const addToolOutput = useCallback(() => {}, [])

  return { messages, status, sendMessage, addToolOutput }
}
