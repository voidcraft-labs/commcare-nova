'use client'
import { useState, useCallback, useRef } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Icon } from '@iconify/react/offline'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { EditableText } from '@/components/builder/EditableText'
import { QuestionTypeGrid } from '@/components/builder/QuestionTypeGrid'
import { useDismissRef } from '@/hooks/useDismissRef'
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
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const typeButtonRef = useRef<HTMLButtonElement>(null)
  const typeDismissRef = useDismissRef(() => setTypePickerOpen(false))
  const { refs: typeRefs, floatingStyles: typeFloatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    elements: { reference: typeButtonRef.current },
    whileElementsMounted: autoUpdate,
  })
  const typePickerRef = useCallback((el: HTMLDivElement | null) => {
    typeRefs.setFloating(el)
    if (!el) return
    const cleanup = typeDismissRef(el)
    return () => {
      cleanup?.()
      typeRefs.setFloating(null as unknown as HTMLDivElement)
    }
  }, [typeRefs, typeDismissRef])

  const saveQuestion = useSaveQuestion(selected, mb, notifyBlueprintChanged)

  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : undefined
  const clearNewlyAdded = () => setNewlyAdded(undefined)

  const isHidden = question.type === 'hidden'

  // Hidden questions have no visible UI — no hint or help. Only the type
  // picker is relevant, and even that is rarely needed.
  const missingTextFields = isHidden ? [] : addableTextFields.filter(f =>
    (f.field === 'hint' || f.field === 'help') && !question[f.field as keyof Question] && newlyAddedField !== f.field,
  )

  return (
      <div className="space-y-3">
        <div>
          <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Type</label>
          <button
            ref={typeButtonRef}
            onClick={() => setTypePickerOpen(!typePickerOpen)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text transition-colors cursor-pointer"
          >
            {questionTypeIcons[question.type] && (
              <Icon icon={questionTypeIcons[question.type]} width="14" height="14" className="shrink-0" />
            )}
            <span>{questionTypeLabels[question.type] ?? question.type}</span>
          </button>
          {typePickerOpen && (
            <FloatingPortal>
              <div
                ref={typePickerRef}
                style={typeFloatingStyles}
                className="z-popover-top"
                onClick={(e) => e.stopPropagation()}
              >
                <QuestionTypeGrid
                  activeType={question.type}
                  variant="elevated"
                  onSelect={(type) => {
                    saveQuestion('type', type)
                    setTypePickerOpen(false)
                  }}
                />
              </div>
            </FloatingPortal>
          )}
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
        {!isHidden && (question.help || newlyAddedField === 'help') && (
          <EditableText
            label="Help"
            value={question.help ?? ''}
            onSave={(v) => {
              saveQuestion('help', v || null)
              clearNewlyAdded()
            }}
            autoFocus={newlyAddedField === 'help'}
            onEmpty={newlyAddedField === 'help' ? clearNewlyAdded : undefined}
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
