'use client'
import { useState, useCallback, useRef } from 'react'
import type { ConversationMessage } from '@/lib/types'
import type { ChatResponse } from '@/lib/schemas/chat'

export interface PendingGeneration {
  appName: string
}

export function useChat(apiKey: string) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [pendingGeneration, setPendingGeneration] = useState<PendingGeneration | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const clearPendingGeneration = useCallback(() => {
    setPendingGeneration(null)
  }, [])

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || !apiKey) return

    const userMessage: ConversationMessage = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    // Add user message + empty assistant placeholder (shows loading dots)
    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)

    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, assistantMessage])

    try {
      abortRef.current = new AbortController()
      const apiMessages = [...messages, userMessage].map(m => ({
        role: m.role,
        content: m.content,
      }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, messages: apiMessages }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) throw new Error('Chat request failed')

      const result = await res.json() as ChatResponse & { error?: string }

      if (result.error) {
        throw new Error(result.error)
      }

      // Update assistant message based on intent
      if (result.intent === 'generate' && result.app_name) {
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            type: 'generation',
            appName: result.app_name!,
            content: result.app_description || '',
          }
          return updated
        })
        setPendingGeneration({ appName: result.app_name })
      } else {
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: result.question || '',
          }
          return updated
        })
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('Chat error:', err)
      setMessages(prev => {
        const updated = [...prev]
        if (updated.length > 0 && updated[updated.length - 1].role === 'assistant') {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: 'Sorry, something went wrong. Please try again.',
          }
        }
        return updated
      })
    } finally {
      setIsLoading(false)
      abortRef.current = null
    }
  }, [apiKey, messages])

  const stopLoading = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  return { messages, isLoading, sendMessage, stopLoading, clearMessages, setMessages, pendingGeneration, clearPendingGeneration }
}
