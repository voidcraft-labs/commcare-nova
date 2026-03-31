'use client'
import { useState, useCallback, useRef, type ReactNode } from 'react'
import { useEditContext } from '@/hooks/useEditContext'
import type { QuestionPath } from '@/lib/services/questionPath'

interface EditableQuestionWrapperProps {
  questionPath: QuestionPath
  children: ReactNode
  style?: React.CSSProperties
  isDragging?: boolean
}

export function EditableQuestionWrapper({
  questionPath,
  children,
  style,
  isDragging,
}: EditableQuestionWrapperProps) {
  const ctx = useEditContext()
  const [hovered, setHovered] = useState(false)
  const [holdReady, setHoldReady] = useState(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasDraggingRef = useRef(false)

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    clearHoldTimer()
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null
      setHoldReady(true)
    }, 300)
  }, [clearHoldTimer])

  const handlePointerUp = useCallback(() => {
    clearHoldTimer()
    setHoldReady(false)
  }, [clearHoldTimer])

  const handlePointerLeave = useCallback(() => {
    clearHoldTimer()
    if (!isDragging) setHoldReady(false)
  }, [clearHoldTimer, isDragging])

  // Reset hold only on drag end transition (isDragging: true → false)
  if (isDragging) wasDraggingRef.current = true
  if (!isDragging && wasDraggingRef.current) {
    wasDraggingRef.current = false
    if (holdReady) setHoldReady(false)
  }

  const builder = ctx?.builder
  const moduleIndex = ctx?.moduleIndex
  const formIndex = ctx?.formIndex

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!builder || moduleIndex === undefined || formIndex === undefined) return
    // Ignore clicks from portal-rendered elements (e.g. QuestionTypePicker FloatingPortal).
    // React synthetic events still bubble through the React tree from portals,
    // but the DOM target is outside this wrapper's subtree.
    const target = e.target as HTMLElement
    if (!e.currentTarget.contains(target)) return
    // Don't intercept clicks that belong to nested question wrappers or insertion points
    if (target.closest('[data-insertion-point]')) return
    const closestWrapper = target.closest('[data-question-wrapper]')
    if (closestWrapper && closestWrapper !== e.currentTarget) return
    e.stopPropagation()
    builder.select({ type: 'question', moduleIndex, formIndex, questionPath })
    // Scroll the matching tree row into view if not already visible
    const treeRow = document.querySelector(`[data-tree-question="${questionPath}"]`) as HTMLElement | null
    if (treeRow) {
      const parent = treeRow.closest('[class*="overflow-auto"]') as HTMLElement | null
      if (parent) {
        const parentRect = parent.getBoundingClientRect()
        const rowRect = treeRow.getBoundingClientRect()
        const isVisible = rowRect.top >= parentRect.top && rowRect.bottom <= parentRect.bottom
        if (!isVisible) {
          treeRow.style.scrollMarginTop = '20px'
          treeRow.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }
    }
  }, [builder, moduleIndex, formIndex, questionPath])

  if (!ctx || ctx.mode === 'test') {
    return <div style={style}>{children}</div>
  }

  /* Text mode: no outlines, no click capture, no pointer-events-none.
   * Children are fully interactive so TextEditable instances inside can
   * receive clicks directly and activate inline editors. */
  if (ctx.cursorMode === 'text') {
    return <div style={style}>{children}</div>
  }

  const isSelected = builder?.selected?.type === 'question'
    && builder.selected.moduleIndex === moduleIndex
    && builder.selected.formIndex === formIndex
    && builder.selected.questionPath === questionPath

  const mergedStyle = holdReady ? { ...style, cursor: 'grabbing' as const } : style

  return (
    <div
      data-question-wrapper
      className={`group/qw relative rounded-lg transition-all duration-150 cursor-pointer outline-offset-3 ${
        isSelected
          ? 'outline-2 outline-nova-cyan bg-nova-cyan/[0.03]'
          : hovered
            ? 'outline-1 outline-nova-cyan/30'
            : 'outline-1 outline-nova-cyan/10'
      }`}
      style={mergedStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClickCapture={handleClick}
    >
      <div className="pointer-events-none" tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
