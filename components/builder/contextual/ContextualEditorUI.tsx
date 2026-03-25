'use client'
import { useState, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { EditableText } from '@/components/builder/EditableText'
import { EditableDropdown } from '@/components/builder/EditableDropdown'
import { QuestionTypeGrid } from '@/components/builder/QuestionTypeGrid'
import { Badge } from '@/components/ui/Badge'
import { useDismissRef } from '@/hooks/useDismissRef'
import { requiredOptions, addableTextFields } from './shared'

const XPathEditorModal = dynamic(
  () => import('@/components/builder/XPathEditorModal').then(m => ({ default: m.XPathEditorModal })),
  { ssr: false },
)

interface ContextualEditorUIProps {
  question: Question
  selected: SelectedElement
  mb: MutableBlueprint
  builder: Builder
  notifyBlueprintChanged: () => void
}

export function ContextualEditorUI({ question, selected, mb, builder, notifyBlueprintChanged }: ContextualEditorUIProps) {
  const [xpathModal, setXpathModal] = useState<{ field: string; value: string; label: string }>()
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

  const handleRequiredChange = useCallback((value: string) => {
    if (value === 'conditional') {
      setXpathModal({
        field: 'required',
        value: question?.required && question.required !== 'true()' ? question.required : '',
        label: 'Required When',
      })
    } else {
      saveQuestion('required', value || null)
    }
  }, [question, saveQuestion])

  const requiredValue = !question?.required ? '' : question.required === 'true()' ? 'true()' : 'conditional'

  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : undefined
  const clearNewlyAdded = () => setNewlyAdded(undefined)

  const missingTextFields = addableTextFields.filter(f =>
    f.field === 'hint' && !question.hint && newlyAddedField !== 'hint',
  )

  return (
    <>
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
        <EditableDropdown
          label="Required"
          value={requiredValue}
          options={
            question.required && question.required !== 'true()'
              ? [
                  { value: '', label: 'Not required' },
                  { value: 'true()', label: 'Always required' },
                  { value: 'conditional', label: `Conditional: ${question.required}` },
                ]
              : requiredOptions
          }
          onSave={handleRequiredChange}
          renderValue={(v) => {
            if (v === 'true()') return <Badge variant="amber">Required</Badge>
            if (v === 'conditional') return <Badge variant="amber">Required when: {question?.required}</Badge>
            return <span className="text-sm text-nova-text-muted">Not required</span>
          }}
        />
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

      {xpathModal && (
        <XPathEditorModal
          value={xpathModal.value}
          label={xpathModal.label}
          onSave={(value) => {
            saveQuestion(xpathModal.field, value || null)
            setXpathModal(undefined)
          }}
          onClose={() => setXpathModal(undefined)}
          getLintContext={() => {
            const blueprint = mb.getBlueprint()
            const form = mb.getForm(selected.moduleIndex, selected.formIndex!)
            const mod = mb.getModule(selected.moduleIndex)
            if (!form) return undefined
            return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
          }}
        />
      )}
    </>
  )
}
