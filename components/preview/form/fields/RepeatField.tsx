'use client'
import { Icon } from '@iconify/react/offline'
import { useDroppable } from '@dnd-kit/react'
import { CollisionPriority } from '@dnd-kit/abstract'
import ciPlus from '@iconify-icons/ci/plus'
import ciTrash from '@iconify-icons/ci/trash-full'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'
import { useTextEditSave } from '@/hooks/useTextEditSave'
import { TextEditable } from '../TextEditable'
import { FormRenderer } from '../FormRenderer'

interface RepeatFieldProps {
  question: Question
  path: string
  questionPath: QuestionPath
  engine: FormEngine
}

export function RepeatField({ question, path, questionPath, engine }: RepeatFieldProps) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  const saveField = useTextEditSave(questionPath)

  // Make the repeat's children area a droppable target so items can be dropped into empty repeats
  const { ref: droppableRef } = useDroppable({
    id: `${questionPath}:container`,
    type: 'container',
    accept: 'question',
    collisionPriority: CollisionPriority.Low,
    disabled: !isEditMode,
  })

  if (!state.visible) return null

  const count = engine.getRepeatCount(path)
  const instances = Array.from({ length: count }, (_, i) => i)

  return (
    <div className="space-y-3">
      {question.label && (
        <TextEditable value={question.label ?? ''} onSave={saveField ? (v) => saveField('label', v) : undefined} fieldType="label">
          <div className="text-sm font-medium text-nova-text"><LabelContent label={question.label ?? ''} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
        </TextEditable>
      )}
      {instances.map((idx) => (
        <div key={idx} className="rounded-lg border border-pv-input-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-pv-surface border-b border-pv-input-border">
            <span className="text-xs font-medium text-nova-text-secondary">
              #{idx + 1}
            </span>
            {count > 1 && (
              <button
                type="button"
                onClick={() => engine.removeRepeat(path, idx)}
                className="p-1 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
              >
                <Icon icon={ciTrash} width="14" height="14" />
              </button>
            )}
          </div>
          <div ref={droppableRef} className="p-4 space-y-4 min-h-[72px]">
            <FormRenderer questions={question.children ?? []} engine={engine} prefix={`${path}[${idx}]`} parentPath={questionPath} />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => engine.addRepeat(path)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-pv-accent hover:text-pv-accent-bright border border-pv-input-border hover:border-pv-input-focus rounded-lg transition-colors cursor-pointer"
      >
        <Icon icon={ciPlus} width="14" height="14" />
        Add {state.resolvedLabel ?? question.label ?? 'entry'}
      </button>
    </div>
  )
}
