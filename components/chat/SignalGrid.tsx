'use client'
import { useRef, useEffect, useCallback } from 'react'
import type { UIMessage } from 'ai'
import { useBuilder } from '@/hooks/useBuilder'
import { SignalGridController, type SignalMode } from '@/lib/signalGridController'

interface SignalGridProps {
  mode: SignalMode
  label: string
  messages: UIMessage[]
}

export function SignalGrid({ mode, label, messages }: SignalGridProps) {
  const builder = useBuilder()
  const controllerRef = useRef<SignalGridController | null>(null)
  const builderRef = useRef(builder)
  builderRef.current = builder
  const prevContentLenRef = useRef(0)

  const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return

    const ctrl = new SignalGridController({
      consumeEnergy: () => builderRef.current.drainEnergy(),
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
    }

    const delta = contentLen - prevContentLenRef.current
    if (delta > 0) {
      builder.injectEnergy(delta)
    }
    prevContentLenRef.current = contentLen
  }, [messages, builder])

  const isActive = mode !== 'idle'

  return (
    <div className="nova-panel" data-active={isActive || undefined}>
      {/* Top bezel — etched groove with corner notches */}
      <div className="nova-panel-bezel nova-panel-bezel-top">
        <div className="nova-panel-notch" />
        <div className="nova-panel-groove" />
        {/* Status indicator recessed into the bezel */}
        <div className={`nova-panel-indicator ${isActive ? 'active' : ''}`} />
        <div className="nova-panel-groove" />
        <div className="nova-panel-notch" />
      </div>

      {/* Display well — the recessed area where the LEDs sit */}
      <div className="nova-panel-well">
        <div
          ref={gridCallbackRef}
          className="signal-grid"
        />
      </div>

      {/* Bottom bezel — label etched into the frame */}
      <div className="nova-panel-bezel nova-panel-bezel-bottom">
        <div className="nova-panel-groove" />
        <span className="nova-panel-etch">
          {label && isActive ? label : 'SYS:NEURAL'}
        </span>
        <div className="nova-panel-groove" />
      </div>
    </div>
  )
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i]
  }
}
