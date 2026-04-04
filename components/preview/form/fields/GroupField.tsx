'use client'
import { useDroppable } from '@dnd-kit/react'
import { CollisionPriority } from '@dnd-kit/abstract'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'
import { useTextEditSave } from '@/hooks/useTextEditSave'
import { TextEditable } from '../TextEditable'
import { FormRenderer } from '../FormRenderer'

interface GroupFieldProps {
  question: Question
  path: string
  questionPath: QuestionPath
  engine: FormEngine
}

export function GroupField({ question, path, questionPath, engine }: GroupFieldProps) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  const saveField = useTextEditSave(questionPath)

  const { ref: droppableRef } = useDroppable({
    id: `${questionPath}:container`,
    type: 'container',
    accept: 'question',
    collisionPriority: CollisionPriority.Low,
    disabled: !isEditMode,
  })

  if (!state.visible) return null

  return (
    <div className="rounded-lg border border-pv-input-border overflow-hidden bg-pv-surface">
      {question.label && (
        <div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
          <TextEditable value={question.label ?? ''} onSave={saveField ? (v) => saveField('label', v) : undefined} fieldType="label">
            <div className="text-sm font-medium text-nova-text"><LabelContent label={question.label ?? ''} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
          </TextEditable>
          {question.hint && (
            <div className="mt-0.5">
              <TextEditable value={question.hint} onSave={saveField ? (v) => saveField('hint', v) : undefined} fieldType="hint">
                <div className="text-xs text-nova-text-muted"><LabelContent label={question.hint} resolvedLabel={state.resolvedHint} isEditMode={isEditMode} /></div>
              </TextEditable>
            </div>
          )}
        </div>
      )}
      <div ref={droppableRef} className="p-4 space-y-4 min-h-[72px] bg-pv-bg">
        <FormRenderer questions={question.children ?? []} engine={engine} prefix={path} parentPath={questionPath} />
      </div>
    </div>
  )
}
