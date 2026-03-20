'use client'
import { useDroppable } from '@dnd-kit/react'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'
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

  // Make the group's children area a droppable target so items can be dropped into empty groups
  const { ref: droppableRef } = useDroppable({
    id: `${questionPath}:container`,
    accept: 'question',
    disabled: !isEditMode,
  })

  if (!state.visible) return null

  return (
    <div className="rounded-lg border border-pv-input-border overflow-hidden">
      {question.label && (
        <div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
          <div className="preview-markdown text-sm font-medium text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedLabel ?? question.label ?? '') }} />
          {question.hint && (
            <div className="preview-markdown text-xs text-nova-text-muted mt-0.5" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedHint ?? question.hint) }} />
          )}
        </div>
      )}
      <div ref={droppableRef} className="p-4 space-y-4">
        {renderChildren(question.children ?? [], path, questionPath)}
      </div>
    </div>
  )
}
