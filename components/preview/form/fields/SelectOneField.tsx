'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { ConstraintError } from './ConstraintError'

interface SelectOneFieldProps {
  question: Question
  state: QuestionState
  onChange: (value: string) => void
  onBlur: () => void
}

export function SelectOneField({ question, state, onChange, onBlur }: SelectOneFieldProps) {
  const options = question.options ?? []
  const showError = state.touched && !state.valid

  return (
    <div onBlur={onBlur}>
      <div className="space-y-1.5">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
              state.value === opt.value
                ? 'bg-[var(--pv-accent)]/10 border border-[var(--pv-accent)]/30'
                : showError
                  ? 'bg-[var(--pv-input-bg)] border border-nova-rose/30 hover:border-nova-rose/50'
                  : 'bg-[var(--pv-input-bg)] border border-[var(--pv-input-border)] hover:border-[var(--pv-input-focus)]'
            }`}
          >
            <input
              type="radio"
              name={state.path}
              value={opt.value}
              checked={state.value === opt.value}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
              state.value === opt.value
                ? 'border-[var(--pv-accent)]'
                : 'border-nova-text-muted'
            }`}>
              {state.value === opt.value && (
                <div className="w-2 h-2 rounded-full bg-[var(--pv-accent)]" />
              )}
            </div>
            <span className="text-sm text-nova-text">{opt.label}</span>
          </label>
        ))}
      </div>
      {showError && state.errorMessage && <ConstraintError message={state.errorMessage} />}
    </div>
  )
}
