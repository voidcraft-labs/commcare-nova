'use client'
import { useState } from 'react'
import { Icon } from '@iconify/react/offline'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { EditableText } from '@/components/builder/EditableText'
import { QuestionTypeGrid } from '@/components/builder/QuestionTypeGrid'
import { useFloatingDropdown, DropdownPortal } from '@/hooks/useFloatingDropdown'
import { AddPropertyButton } from './AddPropertyButton'
import { useSaveQuestion } from '@/hooks/useSaveQuestion'
import { addableTextFields } from './shared'

interface ContextualEditorUIProps {
  question: Question
  selected: SelectedElement
  mb: MutableBlueprint
  builder: Builder
  notifyBlueprintChanged: () => void
}

export function ContextualEditorUI({ question, selected, mb, builder, notifyBlueprintChanged }: ContextualEditorUIProps) {
  const [newlyAdded, setNewlyAdded] = useState<{ field: string; questionPath: QuestionPath }>()
  const typePicker = useFloatingDropdown<HTMLButtonElement>({ placement: 'bottom-start', offset: 4 })

  const saveQuestion = useSaveQuestion(selected, mb, notifyBlueprintChanged)

  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : undefined
  const clearNewlyAdded = () => setNewlyAdded(undefined)

  const isHidden = question.type === 'hidden'

  // Hidden questions have no visible UI — no hint. Only the type
  // picker is relevant, and even that is rarely needed.
  const missingTextFields = isHidden ? [] : addableTextFields.filter(f =>
    f.field === 'hint' && !question[f.field as keyof Question] && newlyAddedField !== f.field,
  )

  return (
      <div className="space-y-3">
        <div>
          <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Type</label>
          <button
            ref={typePicker.triggerRef}
            onClick={typePicker.toggle}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text transition-colors cursor-pointer"
          >
            {questionTypeIcons[question.type] && (
              <Icon icon={questionTypeIcons[question.type]} width="14" height="14" className="shrink-0" />
            )}
            <span>{questionTypeLabels[question.type] ?? question.type}</span>
          </button>
          <DropdownPortal dropdown={typePicker} className="z-popover-top" onClick={(e) => e.stopPropagation()}>
            <QuestionTypeGrid
              activeType={question.type}
              variant="elevated"
              onSelect={(type) => {
                saveQuestion('type', type)
                typePicker.close()
              }}
            />
          </DropdownPortal>
        </div>
        {!isHidden && (question.hint || newlyAddedField === 'hint') && (
          <EditableText
            label="Hint"
            value={question.hint ?? ''}
            onSave={(v) => {
              saveQuestion('hint', v || null)
              clearNewlyAdded()
            }}
            autoFocus={newlyAddedField === 'hint'}
            onEmpty={newlyAddedField === 'hint' ? clearNewlyAdded : undefined}
          />
        )}
        {missingTextFields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {missingTextFields.map(({ field, label }) => (
              <AddPropertyButton
                key={field}
                label={label}
                onClick={() => setNewlyAdded({ field, questionPath: selected.questionPath! })}
              />
            ))}
          </div>
        )}
      </div>
  )
}
