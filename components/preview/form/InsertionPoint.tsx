'use client'
import { useState, useRef, useCallback, type RefObject } from 'react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import { useEditContext } from '@/hooks/useEditContext'
import { dismissContentPopovers } from '@/hooks/useContentPopover'
import type { QuestionPath } from '@/lib/services/questionPath'
import { QuestionTypePicker } from './QuestionTypePicker'

/** Speed threshold in px/ms. Above this = cursor is traversing, don't open. */
const SPEED_THRESHOLD = 0.01
/** How often (ms) to re-check speed while waiting for cursor to slow down. */
const POLL_INTERVAL = 16
/** Per-tick decay factor applied to EMA when cursor is stationary. */
const POLL_DECAY = 0.15
/** Time (ms) with no mousemove events before the cursor is considered stationary. ~2 frames at 60fps. */
const STALE_THRESHOLD = 32

interface InsertionPointProps {
  atIndex: number
  parentPath?: QuestionPath
  disabled?: boolean
  cursorSpeedRef?: RefObject<number>
  lastCursorRef?: RefObject<{ x: number; y: number; t: number } | undefined>
}

export function InsertionPoint({ atIndex, parentPath, disabled, cursorSpeedRef, lastCursorRef }: InsertionPointProps) {
  const ctx = useEditContext()
  const [hovered, setHovered] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const show = useCallback(() => {
    clearPoll()
    pendingRef.current = false
    setHovered(true)
  }, [clearPoll])

  const handleMouseEnter = useCallback(() => {
    if (isOpen) return
    const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD
    if (!fast) {
      show()
    } else {
      // Fast entry — poll until EMA decays below threshold
      pendingRef.current = true
      clearPoll()
      pollRef.current = setInterval(() => {
        // If cursor hasn't moved in 2 frames, it's stationary — decay EMA toward 0
        const lastT = lastCursorRef?.current?.t ?? 0
        if (performance.now() - lastT > STALE_THRESHOLD) {
          if (cursorSpeedRef) cursorSpeedRef.current *= (1 - POLL_DECAY)
        }
        if ((cursorSpeedRef?.current ?? 0) <= SPEED_THRESHOLD) {
          show()
        }
      }, POLL_INTERVAL)
    }
  }, [isOpen, cursorSpeedRef, lastCursorRef, show, clearPoll])

  const handleMouseMove = useCallback(() => {
    if (!pendingRef.current) return
    const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD
    if (!fast) show()
  }, [cursorSpeedRef, show])

  const handleMouseLeave = useCallback(() => {
    clearPoll()
    pendingRef.current = false
    if (!isOpen) setHovered(false)
  }, [isOpen, clearPoll])

  /** Open the type picker. Uses mouseDown (not click) so the open action runs
   *  in the same event as useDismissRef handlers on other popovers. React
   *  batches both updates into one commit — no layout shift from the first
   *  InsertionPoint collapsing before the second opens. */
  const handleOpen = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    dismissContentPopovers()
    setIsOpen(true)
  }, [])

  /** Prevent click from bubbling to parent question wrappers. */
  const stopClick = useCallback((e: React.MouseEvent) => { e.stopPropagation() }, [])

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
          ? 'height 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms, margin 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms'
          : 'height 50ms ease-in, margin 50ms ease-in',
      }}
      data-insertion-point
    >
      {/* Invisible hover detector extending into adjacent gaps */}
      <div
        className="absolute inset-x-0 -top-2 -bottom-2 z-raised cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleOpen}
        onClick={stopClick}
      />

      {/* Visible content — vertically centered in the expanded area */}
      <div
        ref={anchorRef}
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center transition-opacity duration-150 ${
          isActive ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex-1 h-px bg-nova-cyan/40" />
        <button
          onMouseDown={handleOpen}
          onClick={stopClick}
          className="mx-1 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-cyan/40 text-nova-cyan hover:bg-nova-cyan/10 transition-colors cursor-pointer shrink-0"
          title="Insert question"
        >
          <Icon icon={ciAddPlus} width="12" height="12" />
        </button>
        <div className="flex-1 h-px bg-nova-cyan/40" />
      </div>

      {/* Question type picker popover */}
      {isOpen && anchorRef.current && (
        <QuestionTypePicker
          anchorEl={anchorRef.current}
          atIndex={atIndex}
          parentPath={parentPath}
          onClose={() => { setIsOpen(false); setHovered(false) }}
        />
      )}
    </div>
  )
}
