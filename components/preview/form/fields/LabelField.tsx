'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'

export function LabelField({ question, state }: { question: Question; state: QuestionState }) {
  return (
    <div className="py-1">
      <p className="text-sm text-nova-text">{state.resolvedLabel ?? question.label}</p>
      {question.hint && (
        <p className="text-xs text-nova-text-muted mt-0.5">{state.resolvedHint ?? question.hint}</p>
      )}
    </div>
  )
}
