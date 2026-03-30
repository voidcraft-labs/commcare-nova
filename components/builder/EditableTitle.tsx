'use client'
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciCheck from '@iconify-icons/ci/check'

interface EditableTitleProps {
  value: string
  onSave: (value: string) => void
  onSaved?: () => void
}

/**
 * Inline editable title — renders an input that looks like an h2 when unfocused.
 * Click to edit, Enter/blur to save, Escape to cancel.
 * Uses a hidden span mirror to size the input exactly to its content.
 * Calls `onSaved` after a successful save so the parent can show a checkmark wherever it wants.
 */
export function EditableTitle({ value, onSave, onSaved }: EditableTitleProps) {
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
      onSave(trimmed)
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

  return (
    <>
      {/* Hidden span that mirrors the input text for pixel-accurate width measurement */}
      <span
        ref={(el) => { measureRef.current = el; syncWidth() }}
        className="text-lg font-display font-semibold px-1 border border-transparent absolute invisible whitespace-pre"
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
        className={`text-lg font-display font-semibold outline-none rounded px-1 -mx-1 border transition-colors min-w-0 ${
          focused
            ? 'text-nova-text border-nova-violet/60 bg-nova-surface'
            : 'text-nova-text border-transparent cursor-text hover:border-nova-border bg-transparent'
        }`}
        autoComplete="off"
        data-1p-ignore
      />
    </>
  )
}

/** Animated checkmark shown after a title save. */
export function SavedCheck({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2 }}
          className="shrink-0 -ml-1"
        >
          <Icon icon={ciCheck} width="16" height="16" className="text-emerald-400" />
        </motion.span>
      )}
    </AnimatePresence>
  )
}
