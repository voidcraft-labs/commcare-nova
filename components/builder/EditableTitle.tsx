'use client'
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciCheck from '@iconify-icons/ci/check'

// Shared className constants — single source of truth for the typographic and box-model
// properties that must be identical across the readOnly and editable render paths.
// Any divergence here would produce a layout shift when toggling between design/preview.
const MEASURE_SPAN_CLASS = 'text-lg font-display font-semibold px-1 border border-transparent absolute invisible whitespace-pre'
const INPUT_BASE_CLASS = 'text-lg font-display font-semibold outline-none rounded px-1 -mx-1 border text-nova-text'

interface EditableTitleProps {
  value: string
  /** Called when the user commits a new title. Optional when `readOnly` is true. */
  onSave?: (value: string) => void
  onSaved?: () => void
  /**
   * When true, renders the input non-interactively using the exact same element
   * and box model as the editable version. This ensures pixel-perfect flipbook
   * consistency when switching between design and preview modes — no layout shift.
   */
  readOnly?: boolean
}

/**
 * Inline editable title — renders an input that looks like an h2 when unfocused.
 * Click to edit, Enter/blur to save, Escape to cancel.
 * Uses a hidden span mirror to size the input exactly to its content.
 * Calls `onSaved` after a successful save so the parent can show a checkmark wherever it wants.
 *
 * Pass `readOnly` to render the same element in a frozen, non-interactive state —
 * used by preview mode so the title occupies identical space to the design-mode input.
 */
export function EditableTitle({ value, onSave, onSaved, readOnly }: EditableTitleProps) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const committedRef = useRef(false)

  const displayValue = focused ? draft : value

  const syncWidth = useCallback(() => {
    if (measureRef.current && inputRef.current) {
      inputRef.current.style.width = `${measureRef.current.scrollWidth + 4}px`
    }
  }, [])

  const handleFocus = useCallback(() => {
    committedRef.current = false
    setDraft(value)
    setFocused(true)
  }, [value])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    setFocused(false)
    inputRef.current?.blur()
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onSave?.(trimmed)
      onSaved?.()
    }
  }, [draft, value, onSave, onSaved])

  const cancel = useCallback(() => {
    committedRef.current = true
    setFocused(false)
    inputRef.current?.blur()
  }, [])

  const handleBlur = useCallback(() => {
    if (committedRef.current) {
      committedRef.current = false
      return
    }
    commit()
  }, [commit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  // Read-only path: same element and box model as the editable input, just frozen.
  // Using the identical span+input structure guarantees pixel-perfect alignment
  // with design mode — no layout shift when flipping between modes.
  if (readOnly) {
    return (
      <>
        <span
          ref={(el) => { measureRef.current = el; syncWidth() }}
          className={MEASURE_SPAN_CLASS}
          aria-hidden
        >
          {value || '\u00A0'}
        </span>
        <input
          ref={(el) => { inputRef.current = el; syncWidth() }}
          value={value}
          readOnly
          className={`${INPUT_BASE_CLASS} border-transparent bg-transparent pointer-events-none`}
          autoComplete="off"
          data-1p-ignore
        />
      </>
    )
  }

  return (
    <>
      {/* Hidden span that mirrors the input text for pixel-accurate width measurement */}
      <span
        ref={(el) => { measureRef.current = el; syncWidth() }}
        className={MEASURE_SPAN_CLASS}
        aria-hidden
      >
        {displayValue || '\u00A0'}
      </span>
      <input
        ref={(el) => { inputRef.current = el; syncWidth() }}
        value={displayValue}
        onChange={(e) => { setDraft(e.target.value); requestAnimationFrame(syncWidth) }}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        className={`${INPUT_BASE_CLASS} transition-colors min-w-0 ${
          focused
            ? 'border-nova-violet/60 bg-nova-surface'
            : 'border-transparent cursor-text hover:border-nova-border bg-transparent'
        }`}
        autoComplete="off"
        data-1p-ignore
      />
    </>
  )
}

/** Animated emerald checkmark shown after a successful save. */
export function SavedCheck({ visible, size = 16, className = 'shrink-0 -ml-1' }: { visible: boolean; size?: number; className?: string }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2 }}
          className={className}
        >
          <Icon icon={ciCheck} width={size} height={size} className="text-emerald-400" />
        </motion.span>
      )}
    </AnimatePresence>
  )
}
