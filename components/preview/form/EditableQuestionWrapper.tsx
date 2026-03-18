'use client'
import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import ciTrashFull from '@iconify-icons/ci/trash-full'
import tablerGripVertical from '@iconify-icons/tabler/grip-vertical'
import { useEditContext } from '@/hooks/useEditContext'

interface EditableQuestionWrapperProps {
  questionId: string
  children: ReactNode
  style?: React.CSSProperties
  onDelete?: () => void
  isDragging?: boolean
}

export function EditableQuestionWrapper({
  questionId,
  children,
  style,
  onDelete,
  isDragging,
}: EditableQuestionWrapperProps) {
  const ctx = useEditContext()
  const [hovered, setHovered] = useState(false)
  const [holdReady, setHoldReady] = useState(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasDraggingRef = useRef(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

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

  // Compute selection before conditional return (needed for scroll-into-view hook)
  const isSelected = !!ctx && ctx.mode !== 'test'
    && ctx.builder.selected?.type === 'question'
    && ctx.builder.selected.moduleIndex === ctx.moduleIndex
    && ctx.builder.selected.formIndex === ctx.formIndex
    && ctx.builder.selected.questionPath === questionId

  // Scroll selected question into view after view switch (Tree → Preview)
  useEffect(() => {
    if (isSelected && wrapperRef.current) {
      const timer = setTimeout(() => {
        wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 250)
      return () => clearTimeout(timer)
    }
  }, [isSelected])

  if (!ctx || ctx.mode === 'test') {
    return <div style={style}>{children}</div>
  }

  const { builder, moduleIndex, formIndex } = ctx

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't intercept clicks that belong to nested question wrappers or insertion points
    const target = e.target as HTMLElement
    if (target.closest('[data-insertion-point]')) return
    const closestWrapper = target.closest('[data-question-wrapper]')
    if (closestWrapper && closestWrapper !== e.currentTarget) return
    e.stopPropagation()
    builder.select({ type: 'question', moduleIndex, formIndex, questionPath: questionId })
  }, [builder, moduleIndex, formIndex, questionId])

  const mergedStyle = holdReady ? { ...style, cursor: 'grabbing' as const } : style

  return (
    <div
      ref={wrapperRef}
      data-question-wrapper
      className={`relative rounded-lg transition-all duration-150 cursor-pointer p-3 ${
        isSelected
          ? 'ring-2 ring-nova-violet bg-nova-violet/[0.03]'
          : hovered
            ? 'ring-1 ring-nova-violet/30'
            : ''
      }`}
      style={mergedStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClickCapture={handleClick}
    >
      {(hovered || isDragging) && (
        <div
          className="absolute -left-6 top-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing text-nova-text-muted hover:text-nova-text"
          style={{ opacity: 0.5 }}
        >
          <Icon icon={tablerGripVertical} width="16" height="16" />
        </div>
      )}

      {(hovered || isSelected) && onDelete && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 z-10" data-no-drag>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
            title="Delete question"
          >
            <Icon icon={ciTrashFull} width="12" height="12" />
          </button>
        </div>
      )}

      <div className="pointer-events-none" tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
