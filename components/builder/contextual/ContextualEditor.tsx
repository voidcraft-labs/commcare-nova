'use client'
import { useState, useRef, useLayoutEffect } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import type { Builder } from '@/lib/services/builder'
import { ContextualEditorTabs, type EditorTab } from './ContextualEditorTabs'
import { ContextualEditorUI } from './ContextualEditorUI'
import { ContextualEditorLogic } from './ContextualEditorLogic'
import { ContextualEditorData } from './ContextualEditorData'
import { ContextualEditorFooter } from './ContextualEditorFooter'

interface ContextualEditorProps {
  builder: Builder
}

export function ContextualEditor({ builder }: ContextualEditorProps) {
  const selected = builder.selected
  const mb = builder.mb

  // Hooks must be called unconditionally (before any early return)
  const { refs, floatingStyles } = useFloating({
    placement: 'bottom',
    middleware: [
      offset(-20),
      flip(),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  const animRef = useRef<HTMLDivElement>(null)
  const questionPath = selected?.type === 'question' ? selected.questionPath : undefined

  // Reposition the floating reference when the question changes or the blueprint mutates
  // (the question element may shift after edits). Do NOT replay the entrance animation here.
  useLayoutEffect(() => {
    if (!questionPath) return
    const container = document.querySelector(`[data-question-id="${questionPath}"]`)
    const el = container?.querySelector('[data-question-wrapper]') ?? container
    if (el) refs.setReference(el as HTMLElement)
  }, [questionPath, builder.mutationCount, refs])

  // Entrance animation — only on question selection change
  useLayoutEffect(() => {
    if (!questionPath) return
    animRef.current?.animate(
      [
        { opacity: 0, transform: 'scale(0.97)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 150, easing: 'ease-out' },
    )
  }, [questionPath])

  if (!selected || selected.type !== 'question' || !mb || !selected.questionPath) return null

  const question = selected.formIndex !== undefined
    ? mb.getQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath) ?? undefined
    : undefined

  if (!question) return null

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        onClick={(e) => e.stopPropagation()}
        className="z-popover w-72 rounded-xl
          bg-[rgba(10,10,26,0.4)] backdrop-blur-[6px] [-webkit-backdrop-filter:blur(6px)]
          border border-white/[0.1]
          shadow-[0_24px_48px_rgba(0,0,0,0.5)]"
      >
        <div ref={animRef} className="flex flex-col"
        >
          <ContextualEditorInner builder={builder} />
        </div>
      </div>
    </FloatingPortal>
  )
}

function ContextualEditorInner({ builder }: { builder: Builder }) {
  const selected = builder.selected!
  const mb = builder.mb!
  const { notifyBlueprintChanged } = builder

  const question = selected.questionPath && selected.formIndex !== undefined
    ? mb.getQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath) ?? undefined
    : undefined

  const [activeTab, setActiveTab] = useState<EditorTab>('ui')
  const prevPathRef = useRef(selected.questionPath)

  if (selected.questionPath !== prevPathRef.current) {
    prevPathRef.current = selected.questionPath
    setActiveTab('ui')
  }

  if (!question) return null

  return (
    <>
      <ContextualEditorTabs activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="px-3 pb-3 overflow-y-auto max-h-[420px] min-h-0">
        {activeTab === 'ui' && (
          <ContextualEditorUI question={question} selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
        )}
        {activeTab === 'logic' && (
          <ContextualEditorLogic question={question} selected={selected} mb={mb} notifyBlueprintChanged={notifyBlueprintChanged} />
        )}
        {activeTab === 'data' && (
          <ContextualEditorData question={question} selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
        )}
      </div>
      <ContextualEditorFooter selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
    </>
  )
}
