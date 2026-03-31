'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { QuestionState } from '@/lib/preview/engine/types'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'
import { useTextEditSave } from '@/hooks/useTextEditSave'
import { TextEditable } from '../TextEditable'
import { HelpTooltip } from '../HelpTooltip'

export function LabelField({ question, questionPath, state }: { question: Question; questionPath?: QuestionPath; state: QuestionState }) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  /* questionPath is undefined when rendered from QuestionField (dead path —
   * FormRenderer handles labels separately — but TypeScript checks it). */
  const saveField = useTextEditSave(questionPath)

  return (
    <div className="py-1">
      <div className="flex items-center gap-1">
        <TextEditable value={question.label ?? ''} onSave={saveField ? (v) => saveField('label', v) : undefined} fieldType="label">
          <div className="text-sm text-nova-text"><LabelContent label={question.label ?? ''} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
        </TextEditable>
        {question.help && <HelpTooltip help={question.help} isEditMode={isEditMode} />}
      </div>
      {question.hint && (
        <TextEditable value={question.hint} onSave={saveField ? (v) => saveField('hint', v) : undefined} fieldType="hint">
          <div className="text-xs text-nova-text-muted mt-0.5"><LabelContent label={question.hint} resolvedLabel={state.resolvedHint} isEditMode={isEditMode} /></div>
        </TextEditable>
      )}
    </div>
  )
}
