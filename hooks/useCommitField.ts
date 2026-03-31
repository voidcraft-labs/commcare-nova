'use client'
import { useState, useRef, useCallback, useEffect } from 'react'

/** Options for configuring commit/cancel/checkmark behavior. */
interface UseCommitFieldOptions {
  /** Current persisted value — the source of truth outside of editing. */
  value: string
  /** Called when a changed value is committed. */
  onSave: (value: string) => void
  /**
   * Called when the field is committed empty (value cleared + committed).
   * Typically used to trigger deletion of the associated item.
   * Mutually exclusive with `required`.
   */
  onEmpty?: () => void
  /**
   * When true, committing an empty value reverts to the previous value instead
   * of calling onSave. Mutually exclusive with `onEmpty`.
   */
  required?: boolean
  /**
   * Multi-line mode: plain Enter inserts a newline; Cmd/Ctrl+Enter commits.
   * Single-line (default): Enter commits.
   */
  multiline?: boolean
  /** If true, all text is selected when the field gains focus. */
  selectAll?: boolean
}

/** Result returned by useCommitField. */
export interface UseCommitFieldResult {
  /**
   * The value to display in the input: the in-progress draft while focused,
   * or the stable prop value when blurred. Prevents stale draft flicker after
   * blur and correctly reflects undo/redo without a synchronization effect.
   */
  draft: string
  /** Update the internal draft. Wire to the input's onChange handler. */
  setDraft: (v: string) => void
  /** Whether the field is actively being edited. */
  focused: boolean
  /**
   * True for 1.5 seconds after a successful commit.
   * Use this to drive a checkmark animation in the label row.
   */
  saved: boolean
  /** Callback ref to attach to the input/textarea element. */
  ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => void
  /** Wire to the input's onFocus. */
  handleFocus: () => void
  /** Wire to the input's onBlur. */
  handleBlur: () => void
  /**
   * Wire to the input's onKeyDown.
   * - Single-line: Enter commits.
   * - Multiline: Cmd/Ctrl+Enter commits; plain Enter inserts a newline.
   * - Escape: cancels and stopPropagation (prevents useDismissRef from
   *   closing the parent popover when the user only wants to cancel the edit).
   */
  handleKeyDown: (e: React.KeyboardEvent) => void
}

/**
 * Encapsulates the commit/cancel/checkmark model shared across all inline text
 * editors in the builder: EditableText and InlineField (form settings).
 *
 * Draft isolation while focused, Enter/blur to commit, Escape to cancel.
 * committedRef prevents double-commit when Enter triggers blur.
 * `saved` is true for 1.5 s after a successful commit for checkmark animation.
 */
export function useCommitField({
  value,
  onSave,
  onEmpty,
  required,
  multiline,
  selectAll,
}: UseCommitFieldOptions): UseCommitFieldResult {
  const [internalDraft, setInternalDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const [saved, setSaved] = useState(false)

  // Guards against double-commit: set before imperative .blur() so handleBlur
  // knows not to re-commit after Enter or Escape already fired.
  const committedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const ref = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    inputRef.current = el
  }, [])

  // When not focused, always show the authoritative prop value — undo/redo
  // changes are visible without a synchronization effect.
  const draft = focused ? internalDraft : value

  // Clear the saved checkmark after 1.5 s with proper cleanup on unmount.
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 1500)
    return () => clearTimeout(timer)
  }, [saved])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    setFocused(false)
    inputRef.current?.blur()
    const trimmed = internalDraft.trim()
    if (!trimmed && onEmpty) { onEmpty(); return }
    if (required && !trimmed) return
    if (trimmed !== value) { onSave(trimmed); setSaved(true) }
  }, [internalDraft, value, onSave, onEmpty, required])

  const cancel = useCallback(() => {
    committedRef.current = true
    setFocused(false)
    inputRef.current?.blur()
    // If the field had no value to begin with, cancel still removes the item.
    if (!value.trim() && onEmpty) onEmpty()
  }, [value, onEmpty])

  const handleFocus = useCallback(() => {
    committedRef.current = false
    // Snapshot prop value as editing baseline — captures undo/redo changes
    // that happened while the field was blurred.
    setInternalDraft(value)
    setFocused(true)
    if (selectAll) {
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [value, selectAll])

  const handleBlur = useCallback(() => {
    if (committedRef.current) { committedRef.current = false; return }
    commit()
  }, [commit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (multiline) {
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); commit() }
        return
      }
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }, [multiline, commit, cancel])

  return { draft, setDraft: setInternalDraft, focused, saved, ref, handleFocus, handleBlur, handleKeyDown }
}
