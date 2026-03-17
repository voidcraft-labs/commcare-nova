'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { ConstraintError } from './ConstraintError'

interface DateFieldProps {
  question: Question
  state: QuestionState
  onChange: (value: string) => void
  onBlur: () => void
}

export function DateField({ question, state, onChange, onBlur }: DateFieldProps) {
  const inputType = question.type === 'time' ? 'time' : question.type === 'datetime' ? 'datetime-local' : 'date'
  const showError = state.touched && !state.valid

  return (
    <div>
      <input
        type={inputType}
        value={state.value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`w-full px-3 py-2 rounded-lg bg-[var(--pv-input-bg)] border text-sm text-nova-text focus:outline-none transition-colors ${
          showError
            ? 'border-nova-rose/50 focus:border-nova-rose'
            : 'border-[var(--pv-input-border)] focus:border-[var(--pv-input-focus)]'
        }`}
      />
      {showError && state.errorMessage && <ConstraintError message={state.errorMessage} />}
    </div>
  )
}
