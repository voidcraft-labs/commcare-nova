'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { renderPreviewMarkdown } from '@/lib/markdown'

export function LabelField({ question, state }: { question: Question; state: QuestionState }) {
  return (
    <div className="py-1">
      <div className="preview-markdown text-sm text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedLabel ?? question.label ?? '') }} />
      {question.hint && (
        <div className="preview-markdown text-xs text-nova-text-muted mt-0.5" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedHint ?? question.hint) }} />
      )}
    </div>
  )
}
