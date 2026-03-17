'use client'
import type { Question } from '@/lib/schemas/blueprint'

export function LabelField({ question }: { question: Question }) {
  return (
    <div className="py-1">
      <p className="text-sm text-nova-text">{question.label}</p>
      {question.hint && (
        <p className="text-xs text-nova-text-muted mt-0.5">{question.hint}</p>
      )}
    </div>
  )
}
