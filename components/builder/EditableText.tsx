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
  startEditing?: boolean
}

export function EditableText({ label, value, onSave, onEmpty, mono, color, placeholder, multiline, startEditing }: EditableTextProps) {
  const [editing, setEditing] = useState(!!startEditing)
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
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
    setDraft(value)
    setEditing(false)
    if (!value.trim() && onEmpty) {
      onEmpty()
    }
  }, [value, onEmpty])

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
  const colorClass = color || ''

  if (editing) {
    const cls = `w-full text-sm ${fontClass} bg-nova-surface text-nova-text rounded px-2 py-1 border border-nova-violet/30 focus:border-nova-violet/60 focus:outline-none transition-colors`

    return (
      <div>
        <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
          {label}
          {multiline && (
            <span className="ml-auto text-[10px] tracking-normal text-nova-text-secondary font-normal">
              {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + {typeof navigator !== 'undefined' && /Win/.test(navigator.platform) ? 'ENTER' : 'RETURN'} TO SAVE
            </span>
          )}
        </label>
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className={`${cls} resize-none`}
            rows={2}
            placeholder={placeholder}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className={cls}
            placeholder={placeholder}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
        {label}
        <AnimatePresence>
          {saved && (
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
      <p
        onClick={() => setEditing(true)}
        className={`text-sm ${fontClass} ${colorClass} cursor-text hover:underline hover:decoration-dotted hover:decoration-nova-text-muted/40 hover:underline-offset-2 ${!value && placeholder ? 'text-nova-text-muted italic' : 'font-medium'}`}
      >
        {value || placeholder || '\u00A0'}
      </p>
    </div>
  )
}
