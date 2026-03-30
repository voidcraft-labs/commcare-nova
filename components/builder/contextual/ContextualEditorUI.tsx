'use client'
import { useState, useCallback, useRef } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { EditableText } from '@/components/builder/EditableText'
import { QuestionTypeGrid } from '@/components/builder/QuestionTypeGrid'
import { useDismissRef } from '@/hooks/useDismissRef'
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

  const saveQuestion = useCallback((field: string, value: string | null) => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
      [field]: value === '' ? null : value,
    })
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])

  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : undefined
  const clearNewlyAdded = () => setNewlyAdded(undefined)

  const missingTextFields = addableTextFields.filter(f =>
    (f.field === 'hint' || f.field === 'help') && !question[f.field as keyof Question] && newlyAddedField !== f.field,
  )

  return (
      <div className="space-y-3">
        {question.label !== undefined && (
          <EditableText
            label="Label"
            value={question.label ?? ''}
            onSave={(v) => { saveQuestion('label', v || null); builder.clearNewQuestion() }}
            multiline
            autoFocus={builder.isNewQuestion(selected.questionPath!)}
            selectAll={builder.isNewQuestion(selected.questionPath!)}
          />
        )}
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
        {(question.hint || newlyAddedField === 'hint') && (
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
        {(question.help || newlyAddedField === 'help') && (
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
              <button
                key={field}
                onClick={() => setNewlyAdded({ field, questionPath: selected.questionPath! })}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer"
              >
                <Icon icon={ciAddPlus} width="10" height="10" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
  )
}
