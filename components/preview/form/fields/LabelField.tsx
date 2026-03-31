'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionState } from '@/lib/preview/engine/types'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'
import { HelpTooltip } from '../HelpTooltip'

export function LabelField({ question, state }: { question: Question; state: QuestionState }) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  return (
    <div className="py-1">
      <div className="flex items-center gap-1">
        <div className="text-sm text-nova-text"><LabelContent label={question.label ?? ''} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
        {question.help && <HelpTooltip help={question.help} isEditMode={isEditMode} />}
      </div>
      {question.hint && (
        <div className="text-xs text-nova-text-muted mt-0.5"><LabelContent label={question.hint} resolvedLabel={state.resolvedHint} isEditMode={isEditMode} /></div>
      )}
    </div>
  )
}
