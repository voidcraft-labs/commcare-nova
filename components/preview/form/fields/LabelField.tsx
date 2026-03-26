'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { useEditContext } from '@/hooks/useEditContext'
import { HelpTooltip } from '../HelpTooltip'

export function LabelField({ question, state }: { question: Question; state: QuestionState }) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  return (
    <div className="py-1">
      <div className="flex items-center gap-1">
        <span className="preview-markdown text-sm text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedLabel ?? question.label ?? '') }} />
        {question.help && <HelpTooltip help={question.help} isEditMode={isEditMode} />}
      </div>
      {question.hint && (
        <div className="preview-markdown text-xs text-nova-text-muted mt-0.5" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedHint ?? question.hint) }} />
      )}
    </div>
  )
}
