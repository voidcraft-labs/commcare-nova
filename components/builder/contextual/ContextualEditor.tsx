'use client'
import { useState, useRef, useLayoutEffect, useSyncExternalStore } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import type { Builder } from '@/lib/services/builder'
import { ContextualEditorTabs, type EditorTab } from './ContextualEditorTabs'
import { ContextualEditorUI } from './ContextualEditorUI'
import { ContextualEditorLogic } from './ContextualEditorLogic'
import { ContextualEditorData } from './ContextualEditorData'
import { ContextualEditorFooter } from './ContextualEditorFooter'
import { POPOVER_GLASS } from '@/lib/styles'

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
  const [anchorReady, setAnchorReady] = useState(true)
  const questionPath = selected?.type === 'question' ? selected.questionPath : undefined

  // Resolve anchor element: prefer the registered ref callback element, fall back to DOM query.
  // The registered element handles cross-form navigation (element mounts after form transition).
  // The DOM query handles same-form selection (element already in DOM, no wait needed).
  const anchor = useSyncExternalStore(builder.subscribeAnchor, builder.getAnchorSnapshot, () => null)
  const registeredEl = anchor !== null && anchor.path === questionPath ? anchor.el : null

  useLayoutEffect(() => {
    if (!questionPath) return
    const el = registeredEl ?? (() => {
      const container = document.querySelector(`[data-question-id="${questionPath}"]`)
      return (container?.querySelector('[data-question-wrapper]') ?? container) as HTMLElement | null
    })()
    if (el) {
      refs.setReference(el as HTMLElement)
      setAnchorReady(true)
    } else {
      setAnchorReady(false)
    }
  }, [questionPath, registeredEl, builder.mutationCount, refs])

  // Entrance animation — on question selection change or after cross-form anchor resolution
  useLayoutEffect(() => {
    if (!questionPath || !anchorReady) return
    animRef.current?.animate(
      [
        { opacity: 0, transform: 'scale(0.97)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 150, easing: 'ease-out' },
    )
  }, [questionPath, anchorReady])

  if (!selected || selected.type !== 'question' || !mb || !selected.questionPath || !anchorReady) return null

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
        className={`z-popover w-72 ${POPOVER_GLASS}`}
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

  const [activeTab, setActiveTab] = useState<EditorTab>(builder.editorTab)
  const prevPathRef = useRef(selected.questionPath)

  if (selected.questionPath !== prevPathRef.current) {
    prevPathRef.current = selected.questionPath
    setActiveTab('ui')
    builder.setEditorTab('ui')
  }

  if (!question) return null

  return (
    <>
      <ContextualEditorTabs activeTab={activeTab} onTabChange={(tab) => { setActiveTab(tab); builder.setEditorTab(tab) }} />
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
