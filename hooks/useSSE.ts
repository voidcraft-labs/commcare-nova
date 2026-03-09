'use client'
import { useEffect, useRef, useCallback } from 'react'

interface UseSSEOptions {
  onEvent: (event: string, data: any) => void
  onError?: (error: Event) => void
  onOpen?: () => void
}

export function useSSE(url: string | null, options: UseSSEOptions) {
  const esRef = useRef<EventSource | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!url) return

    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => {
      optionsRef.current.onOpen?.()
    }

    es.onerror = (e) => {
      optionsRef.current.onError?.(e)
    }

    // Listen for all named events
    const eventTypes = ['connected', 'tier:scaffold', 'tier:module', 'tier:form', 'status', 'blueprint', 'complete', 'error']
    for (const eventType of eventTypes) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          optionsRef.current.onEvent(eventType, data)
        } catch {
          optionsRef.current.onEvent(eventType, e.data)
        }
      })
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [url])

  const close = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  return { close }
}
