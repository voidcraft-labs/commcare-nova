'use client'
import { useRef, useEffect, useCallback } from 'react'
import type { UIMessage } from 'ai'
import { useBuilder } from '@/hooks/useBuilder'
import type { SignalGridController } from '@/lib/signalGridController'
import type { EditScope } from '@/lib/services/builder'
import { qpathId, type QuestionPath } from '@/lib/services/questionPath'
import { flatIndexById } from '@/lib/services/questionTree'

interface SignalGridProps {
  /** Controller instance — created and owned by the parent (ChatSidebar). */
  controller: SignalGridController
  messages: UIMessage[]
}

export function SignalGrid({ controller, messages }: SignalGridProps) {
  const builder = useBuilder()
  const builderRef = useRef(builder)
  builderRef.current = builder
  /** Null on mount — the first effect records the baseline content length
   *  without injecting energy, preventing a massive brightness spike from
   *  all existing message content being treated as a delta on remount. */
  const prevContentLenRef = useRef<number | null>(null)

  const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    controller.attach(el)
    controller.powerOn()

    const ro = new ResizeObserver(() => controller.resize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      controller.detach()
    }
  }, [controller])

  useEffect(() => {
    const lastAssistant = findLastAssistant(messages)
    if (!lastAssistant) {
      prevContentLenRef.current = 0
      return
    }

    let contentLen = 0
    let latestToolScope: EditScope | null = null

    for (const part of lastAssistant.parts as any[]) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.text) {
        contentLen += part.text.length
      }
      if (part.type?.startsWith('tool-') && part.input != null) {
        contentLen += JSON.stringify(part.input).length

        const input = part.input
        if (typeof input.moduleIndex === 'number') {
          latestToolScope = { moduleIndex: input.moduleIndex }
          if (typeof input.formIndex === 'number') {
            latestToolScope.formIndex = input.formIndex

            const qRef: string | undefined = input.questionPath ?? input.questionId ?? input.path
            if (typeof qRef === 'string' && qRef) {
              const questions = builderRef.current.blueprint
                ?.modules[input.moduleIndex]?.forms[input.formIndex]?.questions
              if (questions) {
                const bareId = qpathId(qRef as QuestionPath)
                const flatIdx = flatIndexById(questions, bareId)
                if (flatIdx >= 0) latestToolScope.questionIndex = flatIdx
              }
            }
          }
        }
      }
    }

    // On first run (mount/remount), record baseline without injecting energy.
    // Content generated while unmounted doesn't need a brightness burst — the
    // headless tick was already advancing state from burst energy data parts.
    if (prevContentLenRef.current !== null) {
      const delta = contentLen - prevContentLenRef.current
      if (delta > 0) {
        builder.injectThinkEnergy(delta * 2)
      }
    }
    prevContentLenRef.current = contentLen

    if (builder.postBuildEdit && builder.agentActive) {
      builder.setEditScope(latestToolScope)
      controller.setEditFocus(builder.computeEditFocus())
    }
  }, [messages, builder, controller])

  return <div ref={gridCallbackRef} className="signal-grid" />
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i]
  }
}
