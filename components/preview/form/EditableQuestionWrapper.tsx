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
  const wrapperElRef = useRef<HTMLDivElement>(null)

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

  // Compute selection before conditional return (needed for scroll-into-view)
  const isSelected = !!ctx && ctx.mode !== 'test'
    && ctx.builder.selected?.type === 'question'
    && ctx.builder.selected.moduleIndex === ctx.moduleIndex
    && ctx.builder.selected.formIndex === ctx.formIndex
    && ctx.builder.selected.questionPath === questionPath

  // Scroll selected question into view after selection changes.
  // 250ms delay accounts for AnimatePresence panel transitions.
  const wrapperRef = useCallback((el: HTMLDivElement | null) => {
    wrapperElRef.current = el
    if (!el || !isSelected) return
    const timer = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 250)
    return () => clearTimeout(timer)
  }, [isSelected])

  if (!ctx || ctx.mode === 'test') {
    return <div style={style}>{children}</div>
  }

  const { builder, moduleIndex, formIndex } = ctx

  const handleClick = useCallback((e: React.MouseEvent) => {
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
  }, [builder, moduleIndex, formIndex, questionPath])

  const mergedStyle = holdReady ? { ...style, cursor: 'grabbing' as const } : style

  return (
    <div
      ref={wrapperRef}
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
