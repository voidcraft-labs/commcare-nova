'use client'
import { useState, useCallback, useRef } from 'react'
import type { ConversationMessage } from '@/lib/types'
import type { ClarifyingQuestion } from '@/lib/schemas/chat'

export interface PendingGeneration {
  appName: string
  appDescription: string
}

export interface ActiveQuestionState {
  questions: ClarifyingQuestion[]
  currentIndex: number
  answers: Record<string, string>
}

export function useChat(apiKey: string) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [pendingGeneration, setPendingGeneration] = useState<PendingGeneration | null>(null)
  const [activeQuestions, setActiveQuestions] = useState<ActiveQuestionState | null>(null)
  const [sessionId] = useState(() => crypto.randomUUID())
  const hasSessionRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const respondToSession = useCallback(async (data: unknown) => {
    try {
      await fetch('/api/chat/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, data }),
      })
    } catch (err) {
      console.error('Failed to respond to session:', err)
    }
  }, [sessionId])

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || !apiKey) return

    // If user types during active question stepper, abandon stepper
    // and send partial answers + free text
    if (activeQuestions) {
      const data = {
        answers: activeQuestions.answers,
        freeText: content,
      }
      setActiveQuestions(null)
      setMessages(prev => [...prev, {
        role: 'user',
        content,
        timestamp: Date.now(),
      }])
      await respondToSession(data)
      return
    }

    const userMessage: ConversationMessage = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)
    setIsThinking(true)

    try {
      abortRef.current = new AbortController()

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          message: content,
          sessionId,
          isResume: hasSessionRef.current,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        throw new Error('Chat request failed')
      }

      hasSessionRef.current = true

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentTextIdx: number | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue

          let event: any
          try {
            event = JSON.parse(line.slice(6))
          } catch {
            continue
          }

          switch (event.type) {
            case 'text_delta': {
              setIsThinking(false)
              setMessages(prev => {
                if (currentTextIdx !== null && currentTextIdx < prev.length) {
                  const updated = [...prev]
                  updated[currentTextIdx] = {
                    ...updated[currentTextIdx],
                    content: updated[currentTextIdx].content + event.content,
                  }
                  return updated
                }
                currentTextIdx = prev.length
                return [...prev, {
                  role: 'assistant',
                  content: event.content,
                  timestamp: Date.now(),
                }]
              })
              break
            }

            case 'questions': {
              setIsThinking(false)
              currentTextIdx = null
              const questions = event.data.questions as ClarifyingQuestion[]
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: '',
                type: 'questions',
                questions,
                timestamp: Date.now(),
              }])
              setActiveQuestions({
                questions,
                currentIndex: 0,
                answers: {},
              })
              break
            }

            case 'generate': {
              setIsThinking(false)
              currentTextIdx = null
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: event.data.appDescription || '',
                type: 'generation',
                appName: event.data.appName,
                appDescription: event.data.appDescription,
                timestamp: Date.now(),
              }])
              break
            }

            case 'processing': {
              setIsThinking(true)
              break
            }

            case 'error': {
              setIsThinking(false)
              currentTextIdx = null
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: event.message || 'Something went wrong.',
                timestamp: Date.now(),
              }])
              break
            }

            case 'done': {
              currentTextIdx = null
              break
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('Chat error:', err)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        timestamp: Date.now(),
      }])
    } finally {
      setIsLoading(false)
      setIsThinking(false)
      abortRef.current = null
    }
  }, [apiKey, sessionId, activeQuestions, respondToSession])

  const selectOption = useCallback((questionText: string, optionLabel: string) => {
    if (!activeQuestions) return

    const newAnswers = { ...activeQuestions.answers, [questionText]: optionLabel }
    const nextIndex = activeQuestions.currentIndex + 1

    if (nextIndex < activeQuestions.questions.length) {
      setActiveQuestions({
        ...activeQuestions,
        currentIndex: nextIndex,
        answers: newAnswers,
      })
    } else {
      setActiveQuestions(null)
      respondToSession({ answers: newAnswers })
    }
  }, [activeQuestions, respondToSession])

  const confirmGeneration = useCallback(() => {
    const genMsg = [...messages].reverse().find(m => m.type === 'generation' && !m.cancelled)
    if (genMsg) {
      setPendingGeneration({
        appName: genMsg.appName!,
        appDescription: genMsg.appDescription || '',
      })
    }
    respondToSession({ confirmed: true })
  }, [messages, respondToSession])

  const cancelGeneration = useCallback(() => {
    setMessages(prev => {
      const updated = [...prev]
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].type === 'generation' && !updated[i].cancelled) {
          updated[i] = { ...updated[i], cancelled: true }
          break
        }
      }
      return updated
    })
    respondToSession({ confirmed: false })
  }, [respondToSession])

  const clearPendingGeneration = useCallback(() => {
    setPendingGeneration(null)
  }, [])

  const stopLoading = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  return {
    messages,
    isLoading,
    isThinking,
    sendMessage,
    stopLoading,
    clearMessages,
    setMessages,
    pendingGeneration,
    clearPendingGeneration,
    activeQuestions,
    selectOption,
    confirmGeneration,
    cancelGeneration,
  }
}
