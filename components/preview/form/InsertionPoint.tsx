'use client'
import { useState, useRef, useCallback, type RefObject } from 'react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import { useEditContext } from '@/hooks/useEditContext'
import { QuestionTypePicker } from './QuestionTypePicker'

/** Speed threshold in px/ms. Above this = cursor is traversing, don't open. */
const SPEED_THRESHOLD = 0.1

interface InsertionPointProps {
  atIndex: number
  parentId?: string
  disabled?: boolean
  cursorSpeedRef?: RefObject<number>
}

export function InsertionPoint({ atIndex, parentId, disabled, cursorSpeedRef }: InsertionPointProps) {
  const ctx = useEditContext()
  const [hovered, setHovered] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
  }, [])

  const show = useCallback(() => {
    clearFallback()
    pendingRef.current = false
    setHovered(true)
  }, [clearFallback])

  const handleMouseEnter = useCallback(() => {
    if (isOpen) return
    const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD
    if (!fast) {
      show()
    } else {
      // Fast entry — wait for slowdown or fallback timeout
      pendingRef.current = true
      fallbackTimerRef.current = setTimeout(show, 200)
    }
  }, [isOpen, cursorSpeedRef, show])

  const handleMouseMove = useCallback(() => {
    if (!pendingRef.current) return
    const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD
    if (!fast) show()
  }, [cursorSpeedRef, show])

  const handleMouseLeave = useCallback(() => {
    clearFallback()
    pendingRef.current = false
    if (!isOpen) setHovered(false)
  }, [isOpen, clearFallback])

  if (!ctx || ctx.mode === 'test') return null
  if (disabled) return null

  const isActive = hovered || isOpen

  return (
    <div
      className="relative"
      style={{
        height: isActive ? 24 : 0,
        marginBottom: isActive ? 16 : 0,
        transition: isActive
          ? 'height 250ms cubic-bezier(0.6, 0, 0.1, 1) 50ms, margin 250ms cubic-bezier(0.6, 0, 0.1, 1) 50ms'
          : 'height 150ms ease-in, margin 150ms ease-in',
      }}
      data-insertion-point
    >
      {/* Invisible hover detector extending into adjacent gaps */}
      <div
        className="absolute inset-x-0 -top-4 -bottom-4 z-20 cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={(e) => { e.stopPropagation(); setIsOpen(true) }}
      />

      {/* Visible content — vertically centered in the expanded area */}
      <div
        ref={anchorRef}
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center transition-opacity duration-150 ${
          isActive ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex-1 h-px bg-nova-violet/40" />
        <button
          onClick={(e) => { e.stopPropagation(); setIsOpen(true) }}
          className="mx-1 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-violet/40 text-nova-violet hover:bg-nova-violet/10 transition-colors cursor-pointer shrink-0"
          title="Insert question"
        >
          <Icon icon={ciAddPlus} width="12" height="12" />
        </button>
        <div className="flex-1 h-px bg-nova-violet/40" />
      </div>

      {/* Question type picker popover */}
      {isOpen && anchorRef.current && (
        <QuestionTypePicker
          anchorEl={anchorRef.current}
          atIndex={atIndex}
          parentId={parentId}
          onClose={() => { setIsOpen(false); setHovered(false) }}
        />
      )}
    </div>
  )
}
