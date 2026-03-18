'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciCheck from '@iconify-icons/ci/check'

interface EditableTextProps {
  label: string
  value: string
  onSave: (value: string) => void
  onEmpty?: () => void
  mono?: boolean
  color?: string
  placeholder?: string
  multiline?: boolean
  autoFocus?: boolean
  selectAll?: boolean
}

export function EditableText({ label, value, onSave, onEmpty, mono, color, placeholder, multiline, autoFocus, selectAll }: EditableTextProps) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const committedRef = useRef(false)

  // Sync external value changes when not editing
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])

  // Auto-focus on mount (replaces startEditing)
  useEffect(() => {
    if (autoFocus) {
      const el = inputRef.current
      if (!el) return
      el.focus()
      if (selectAll) {
        el.select()
      } else {
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFocus = useCallback(() => {
    committedRef.current = false
    setFocused(true)
    if (selectAll) {
      // Defer to after the mouseup that placed the cursor
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [selectAll])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    setFocused(false)
    inputRef.current?.blur()
    const trimmed = draft.trim()
    if (!trimmed && onEmpty) {
      onEmpty()
      return
    }
    if (trimmed !== value) {
      onSave(trimmed)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }, [draft, value, onSave, onEmpty])

  const cancel = useCallback(() => {
    committedRef.current = true
    setDraft(value)
    setFocused(false)
    inputRef.current?.blur()
    if (!value.trim() && onEmpty) {
      onEmpty()
    }
  }, [value, onEmpty])

  const handleBlur = useCallback(() => {
    if (committedRef.current) {
      committedRef.current = false
      return
    }
    commit()
  }, [commit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (multiline) {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault()
          commit()
        }
        // Plain Enter inserts newline naturally
        return
      }
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  const fontClass = mono ? 'font-mono' : ''
  const baseCls = `w-full text-sm ${fontClass} rounded px-2 py-1 border outline-none transition-colors`
  const focusedCls = `${baseCls} bg-nova-surface text-nova-text border-nova-violet/60`
  const unfocusedCls = `${baseCls} bg-transparent border-transparent cursor-text ${color || ''} ${!draft && placeholder ? 'text-nova-text-muted italic' : 'font-medium'} hover:border-nova-border/40`
  const cls = focused ? focusedCls : unfocusedCls

  const lineCount = multiline ? draft.split('\n').length : 1
  const rows = focused ? Math.max(lineCount, 2) : Math.max(lineCount, 1)

  return (
    <div>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
        {label}
        {focused && multiline && (
          <span className="ml-auto text-[10px] tracking-normal text-nova-text-secondary font-normal">
            {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + {typeof navigator !== 'undefined' && /Win/.test(navigator.platform) ? 'ENTER' : 'RETURN'} TO SAVE
          </span>
        )}
        <AnimatePresence>
          {saved && !focused && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              <Icon icon={ciCheck} width="12" height="12" className="text-emerald-400" />
            </motion.span>
          )}
        </AnimatePresence>
      </label>
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={`${cls} resize-none`}
          rows={rows}
          placeholder={placeholder}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={cls}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}
