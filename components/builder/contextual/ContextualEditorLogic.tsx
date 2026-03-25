'use client'
import { useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import type { Question } from '@/lib/schemas/blueprint'
import type { SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { EditableText } from '@/components/builder/EditableText'
import { EditableDropdown } from '@/components/builder/EditableDropdown'
import { Badge } from '@/components/ui/Badge'
import { requiredOptions, xpathFields, addableTextFields } from './shared'

const XPathField = dynamic(
  () => import('@/components/builder/XPathField').then(m => ({ default: m.XPathField })),
  { ssr: false, loading: () => <XPathFieldSkeleton /> },
)
const XPathEditorModal = dynamic(
  () => import('@/components/builder/XPathEditorModal').then(m => ({ default: m.XPathEditorModal })),
  { ssr: false },
)

function XPathFieldSkeleton() {
  return <div className="h-[30px] rounded-md bg-nova-surface border border-[rgba(139,92,246,0.1)] animate-pulse" />
}

interface ContextualEditorLogicProps {
  question: Question
  selected: SelectedElement
  mb: MutableBlueprint
  notifyBlueprintChanged: () => void
}

export function ContextualEditorLogic({ question, selected, mb, notifyBlueprintChanged }: ContextualEditorLogicProps) {
  const [xpathModal, setXpathModal] = useState<{ field: string; value: string; label: string }>()
  const [newlyAdded, setNewlyAdded] = useState<{ field: string; questionPath: QuestionPath }>()

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

  const missingXPathFields = xpathFields.filter(f => !question[f.field as keyof Question])
  const missingValidationMsg = addableTextFields.filter(f =>
    f.field === 'validation_msg' && !question.validation_msg && newlyAddedField !== 'validation_msg' && question.validation,
  )

  const hasContent = question.required || question.validation || question.relevant || question.default_value || question.calculate

  return (
    <>
      <div className="space-y-3">
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
        {question.validation && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Validation</label>
            <XPathField value={question.validation} onClick={() => setXpathModal({ field: 'validation', value: question.validation!, label: 'Validation' })} />
            {(question.validation_msg || newlyAddedField === 'validation_msg') && (
              <div className="mt-1">
                <EditableText
                  label="Validation Message"
                  value={question.validation_msg ?? ''}
                  onSave={(v) => {
                    saveQuestion('validation_msg', v || null)
                    clearNewlyAdded()
                  }}
                  autoFocus={newlyAddedField === 'validation_msg'}
                  onEmpty={newlyAddedField === 'validation_msg' ? clearNewlyAdded : undefined}
                />
              </div>
            )}
          </div>
        )}
        {question.relevant && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Show When</label>
            <XPathField value={question.relevant} onClick={() => setXpathModal({ field: 'relevant', value: question.relevant!, label: 'Show When' })} />
          </div>
        )}
        {question.default_value && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Default Value</label>
            <XPathField value={question.default_value} onClick={() => setXpathModal({ field: 'default_value', value: question.default_value!, label: 'Default Value' })} />
          </div>
        )}
        {question.calculate && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Calculate</label>
            <XPathField value={question.calculate} onClick={() => setXpathModal({ field: 'calculate', value: question.calculate!, label: 'Calculate' })} />
          </div>
        )}

        {/* Add property affordances */}
        {(missingXPathFields.length > 0 || missingValidationMsg.length > 0) && (
          <div className={hasContent ? 'pt-2 border-t border-nova-border/40' : ''}>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">Add Property</label>
            <div className="flex flex-wrap gap-1.5">
              {missingValidationMsg.map(({ field, label }) => (
                <button
                  key={field}
                  onClick={() => setNewlyAdded({ field, questionPath: selected.questionPath! })}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer"
                >
                  <Icon icon={ciAddPlus} width="10" height="10" />
                  {label}
                </button>
              ))}
              {missingXPathFields.map(({ field, label }) => (
                <button
                  key={field}
                  onClick={() => setXpathModal({ field, value: '', label })}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer"
                >
                  <Icon icon={ciAddPlus} width="10" height="10" />
                  {label}
                </button>
              ))}
            </div>
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
