'use client'
import { useState, useCallback, useRef } from 'react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import ciTrashFull from '@iconify-icons/ci/trash-full'

interface OptionsEditorProps {
  options: Array<{ value: string; label: string }>
  onSave: (options: Array<{ value: string; label: string }>) => void
}

export function OptionsEditor({ options, onSave }: OptionsEditorProps) {
  const [draft, setDraft] = useState<Array<{ value: string; label: string }>>(options)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)

  const optionsKey = JSON.stringify(options)
  const prevKeyRef = useRef(optionsKey)
  if (optionsKey !== prevKeyRef.current) {
    prevKeyRef.current = optionsKey
    setDraft(options)
    setFocusIndex(null)
  }

  const commit = useCallback((updated: Array<{ value: string; label: string }>) => {
    const cleaned = updated.filter(o => o.label.trim() || o.value.trim())
    onSave(cleaned)
  }, [onSave])

  const updateOption = useCallback((index: number, field: 'label' | 'value', val: string) => {
    setDraft(prev => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: val }
      return next
    })
  }, [])

  const removeOption = useCallback((index: number) => {
    const next = draft.filter((_, i) => i !== index)
    setDraft(next)
    commit(next)
  }, [draft, commit])

  const addOption = useCallback(() => {
    const num = draft.length + 1
    const next = [...draft, { value: `option_${num}`, label: `Option ${num}` }]
    setDraft(next)
    commit(next)
    setFocusIndex(next.length - 1)
  }, [draft])

  const handleBlur = useCallback((e: React.FocusEvent) => {
    const container = e.currentTarget
    requestAnimationFrame(() => {
      if (!container.contains(document.activeElement)) {
        commit(draft)
        setFocusIndex(null)
      }
    })
  }, [draft, commit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
      commit(draft)
    }
  }, [draft, commit])

  return (
    <div onBlur={handleBlur}>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Options</label>
      <div className="space-y-1.5">
        {draft.map((opt, i) => (
          <div key={i} className="flex items-center gap-1.5 group">
            <div className="flex-1 min-w-0 flex gap-1">
              <input
                value={opt.label}
                onChange={(e) => updateOption(i, 'label', e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Label"
                autoFocus={focusIndex === i}
                className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-nova-surface border border-transparent focus:border-nova-violet/60 text-nova-text outline-none transition-colors"
                autoComplete="off"
                data-1p-ignore
              />
              <input
                value={opt.value}
                onChange={(e) => updateOption(i, 'value', e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="value"
                className="w-24 shrink-0 text-xs font-mono px-2 py-1 rounded bg-nova-surface border border-transparent focus:border-nova-violet/60 text-nova-text-muted outline-none transition-colors"
                autoComplete="off"
                data-1p-ignore
              />
            </div>
            <button
              onClick={() => removeOption(i)}
              className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
              tabIndex={-1}
            >
              <Icon icon={ciTrashFull} width="12" height="12" />
            </button>
          </div>
        ))}
      </div>
      <button
        ref={addRef}
        onClick={addOption}
        className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer"
      >
        <Icon icon={ciAddPlus} width="10" height="10" />
        Add option
      </button>
    </div>
  )
}
