'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { ConstraintError } from './ConstraintError'

interface SelectMultiFieldProps {
  question: Question
  state: QuestionState
  onChange: (value: string) => void
  onBlur: () => void
}

export function SelectMultiField({ question, state, onChange, onBlur }: SelectMultiFieldProps) {
  const options = question.options ?? []
  const selected = new Set(state.value ? state.value.split(' ') : [])
  const showError = state.touched && !state.valid

  const toggle = (optValue: string) => {
    const next = new Set(selected)
    if (next.has(optValue)) next.delete(optValue)
    else next.add(optValue)
    onChange([...next].join(' '))
  }

  return (
    <div onBlur={onBlur}>
      <div className="space-y-1.5">
        {options.map((opt) => {
          const checked = selected.has(opt.value)
          return (
            <label
              key={opt.value}
              onClick={() => toggle(opt.value)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                checked
                  ? 'bg-pv-accent/10 border border-pv-accent/30'
                  : showError
                    ? 'bg-pv-input-bg border border-nova-rose/30 hover:border-nova-rose/50'
                    : 'bg-pv-input-bg border border-pv-input-border hover:border-pv-input-focus'
              }`}
            >
              <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                checked
                  ? 'border-pv-accent bg-pv-accent'
                  : 'border-nova-text-muted'
              }`}>
                {checked && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <span className="preview-markdown text-sm text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(opt.label) }} />
            </label>
          )
        })}
      </div>
      {showError && state.errorMessage && <ConstraintError message={state.errorMessage} />}
    </div>
  )
}
