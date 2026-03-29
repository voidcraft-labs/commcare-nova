'use client'
import { useState, useRef, useLayoutEffect, useSyncExternalStore } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal, type Placement } from '@floating-ui/react'
import type { Builder } from '@/lib/services/builder'
import { ContextualEditorTabs, type EditorTab } from './ContextualEditorTabs'
import { ContextualEditorUI } from './ContextualEditorUI'
import { ContextualEditorLogic } from './ContextualEditorLogic'
import { ContextualEditorData } from './ContextualEditorData'
import { ContextualEditorFooter } from './ContextualEditorFooter'
import { POPOVER_GLASS } from '@/lib/styles'

interface ContextualEditorProps {
  builder: Builder
  scrolling?: boolean
}

export function ContextualEditor({ builder, scrolling }: ContextualEditorProps) {
  const selected = builder.selected
  const mb = builder.mb
  const questionPath = selected?.type === 'question' ? selected.questionPath : undefined

  // Sticky placement: feed resolved placement back as the preferred placement.
  // flip() only moves away from the current side if it actually overflows,
  // preventing re-flips when content shrinks (e.g. switching editor tabs).
  // Resets to 'bottom' on question change so each question starts fresh.
  const [stickyPlacement, setStickyPlacement] = useState<Placement>('bottom')
  const prevQuestionPathRef = useRef(questionPath)
  if (questionPath !== prevQuestionPathRef.current) {
    prevQuestionPathRef.current = questionPath
    setStickyPlacement('bottom')
  }

  // Hooks must be called unconditionally (before any early return)
  const { refs, floatingStyles, placement } = useFloating({
    placement: stickyPlacement,
    middleware: [
      offset(-20),
      flip(),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    setStickyPlacement(placement)
  }, [placement])

  const animRef = useRef<HTMLDivElement>(null)
  const [anchorReady, setAnchorReady] = useState(true)

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

  // Entrance animation — on question change, anchor resolution, or scroll settle
  useLayoutEffect(() => {
    if (!questionPath || !anchorReady || scrolling) return
    animRef.current?.animate(
      [
        { opacity: 0, transform: 'scale(0.97)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 150, easing: 'ease-out' },
    )
  }, [questionPath, anchorReady, scrolling])

  if (!selected || selected.type !== 'question' || !mb || !selected.questionPath || !anchorReady || scrolling) return null

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
      <div className="grid max-h-[420px] min-h-0 overflow-y-auto">
        <div className={`px-3 pb-3 min-w-0 ${activeTab !== 'ui' ? 'invisible' : ''}`} style={{ gridArea: '1/1' }} inert={activeTab !== 'ui'}>
          <ContextualEditorUI question={question} selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
        </div>
        <div className={`px-3 pb-3 min-w-0 ${activeTab !== 'logic' ? 'invisible' : ''}`} style={{ gridArea: '1/1' }} inert={activeTab !== 'logic'}>
          <ContextualEditorLogic question={question} selected={selected} mb={mb} notifyBlueprintChanged={notifyBlueprintChanged} />
        </div>
        <div className={`px-3 pb-3 min-w-0 ${activeTab !== 'data' ? 'invisible' : ''}`} style={{ gridArea: '1/1' }} inert={activeTab !== 'data'}>
          <ContextualEditorData question={question} selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
        </div>
      </div>
      <ContextualEditorFooter selected={selected} mb={mb} builder={builder} notifyBlueprintChanged={notifyBlueprintChanged} />
    </>
  )
}
