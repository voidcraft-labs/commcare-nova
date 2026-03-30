'use client'
import { useDroppable } from '@dnd-kit/react'
import { CollisionPriority } from '@dnd-kit/abstract'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'

interface GroupFieldProps {
  question: Question
  path: string
  questionPath: QuestionPath
  engine: FormEngine
  renderChildren: (questions: Question[], prefix: string, parentPath: QuestionPath) => React.ReactNode
}

export function GroupField({ question, path, questionPath, engine, renderChildren }: GroupFieldProps) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  const { ref: droppableRef } = useDroppable({
    id: `${questionPath}:container`,
    type: 'container',
    accept: 'question',
    collisionPriority: CollisionPriority.Low,
    disabled: !isEditMode,
  })

  if (!state.visible) return null

  return (
    <div className="rounded-lg border border-pv-input-border overflow-hidden">
      {question.label && (
        <div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
          <div className="text-sm font-medium text-nova-text"><LabelContent label={question.label ?? ''} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
          {question.hint && (
            <div className="text-xs text-nova-text-muted mt-0.5"><LabelContent label={question.hint} resolvedLabel={state.resolvedHint} isEditMode={isEditMode} /></div>
          )}
        </div>
      )}
      <div ref={droppableRef} className="p-4 space-y-4 min-h-[72px]">
        {renderChildren(question.children ?? [], path, questionPath)}
      </div>
    </div>
  )
}
