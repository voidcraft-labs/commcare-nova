'use client'
import { useRef, useEffect, useCallback } from 'react'
import type { UIMessage } from 'ai'
import { useBuilder } from '@/hooks/useBuilder'
import { SignalGridController, type SignalMode } from '@/lib/signalGridController'
import { SignalPanel } from '@/components/chat/SignalPanel'

interface SignalGridProps {
  mode: SignalMode
  label: string
  suffix?: string
  messages: UIMessage[]
}

export function SignalGrid({ mode, label, suffix, messages }: SignalGridProps) {
  const builder = useBuilder()
  const controllerRef = useRef<SignalGridController | null>(null)
  const builderRef = useRef(builder)
  builderRef.current = builder
  const prevContentLenRef = useRef(0)

  const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return

    const ctrl = new SignalGridController({
      consumeEnergy: () => builderRef.current.drainEnergy(),
      consumeThinkEnergy: () => builderRef.current.drainThinkEnergy(),
    })
    controllerRef.current = ctrl
    ctrl.attach(el)
    ctrl.powerOn()

    const ro = new ResizeObserver(() => ctrl.resize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      ctrl.detach()
      controllerRef.current = null
    }
  }, [])

  useEffect(() => {
    controllerRef.current?.setMode(mode)
  }, [mode])

  useEffect(() => {
    const lastAssistant = findLastAssistant(messages)
    if (!lastAssistant) {
      prevContentLenRef.current = 0
      return
    }

    let contentLen = 0
    for (const part of lastAssistant.parts as any[]) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.text) {
        contentLen += part.text.length
      }
      // Track tool input streaming — typed tool parts (tool-addQuestions, etc.)
      // grow their input progressively during input-streaming state.
      // Without this, tool arg generation (the bulk of build time) produces
      // zero energy, making the grid look idle during active generation.
      if (part.type?.startsWith('tool-') && part.input != null) {
        contentLen += JSON.stringify(part.input).length
      }
    }

    const delta = contentLen - prevContentLenRef.current
    if (delta > 0) {
      builder.injectThinkEnergy(delta * 2)
    }
    prevContentLenRef.current = contentLen
  }, [messages, builder])

  return (
    <SignalPanel active={mode !== 'idle'} label={label} suffix={suffix} error={mode === 'error-recovering' || mode === 'error-fatal'}>
      <div ref={gridCallbackRef} className="signal-grid" />
    </SignalPanel>
  )
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i]
  }
}
