'use client'
import { useState, useCallback } from 'react'
import type { XPathLintContext } from '@/lib/codemirror/xpath-lint'
import { Icon } from '@iconify/react/offline'
import ciTrashFull from '@iconify-icons/ci/trash-full'
import type { Question } from '@/lib/schemas/blueprint'
import type { SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { EditableText } from '@/components/builder/EditableText'
import { Toggle } from '@/components/ui/Toggle'
import { XPathField } from '@/components/builder/XPathField'
import { XPathEditorModal } from '@/components/builder/XPathEditorModal'
import { AddPropertyButton } from './AddPropertyButton'
import { useSaveQuestion } from '@/hooks/useSaveQuestion'
import { xpathFields, addableTextFields } from './shared'

interface ContextualEditorLogicProps {
  question: Question
  selected: SelectedElement
  mb: MutableBlueprint
  notifyBlueprintChanged: () => void
}

export function ContextualEditorLogic({ question, selected, mb, notifyBlueprintChanged }: ContextualEditorLogicProps) {
  const [xpathModal, setXpathModal] = useState<{ field: string; value: string; label: string }>()
  const [newlyAdded, setNewlyAdded] = useState<{ field: string; questionPath: QuestionPath }>()

  /** Context getter for XPathField chip resolution and XPathEditorModal linting. */
  const getLintContext = useCallback(() => {
    const blueprint = mb.getBlueprint()
    const form = mb.getForm(selected.moduleIndex, selected.formIndex!)
    const mod = mb.getModule(selected.moduleIndex)
    if (!form) return undefined
    return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
  }, [mb, selected.moduleIndex, selected.formIndex])

  const saveQuestion = useSaveQuestion(selected, mb, notifyBlueprintChanged)

  const hasRequiredCondition = !!question.required && question.required !== 'true()'

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
        {question.required && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-nova-text-muted uppercase tracking-wider">Required</label>
              <Toggle enabled onToggle={() => saveQuestion('required', null)} />
            </div>
            {hasRequiredCondition ? (
              <div className="flex items-center gap-1.5 group/condition">
                <div className="flex-1 min-w-0">
                  <XPathField
                    value={question.required!}
                    getLintContext={getLintContext}
                    onClick={() => setXpathModal({
                      field: 'required',
                      value: question.required!,
                      label: 'Required When',
                    })}
                  />
                </div>
                <button
                  onClick={() => saveQuestion('required', 'true()')}
                  className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover/condition:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
                  tabIndex={-1}
                >
                  <Icon icon={ciTrashFull} width="12" height="12" />
                </button>
              </div>
            ) : (
              <AddPropertyButton
                label="Condition"
                onClick={() => setXpathModal({ field: 'required', value: '', label: 'Required When' })}
              />
            )}
          </div>
        )}

        {question.validation && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Validation</label>
            <XPathField value={question.validation} getLintContext={getLintContext} onClick={() => setXpathModal({ field: 'validation', value: question.validation!, label: 'Validation' })} />
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
            <XPathField value={question.relevant} getLintContext={getLintContext} onClick={() => setXpathModal({ field: 'relevant', value: question.relevant!, label: 'Show When' })} />
          </div>
        )}
        {question.default_value && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Default Value</label>
            <XPathField value={question.default_value} getLintContext={getLintContext} onClick={() => setXpathModal({ field: 'default_value', value: question.default_value!, label: 'Default Value' })} />
          </div>
        )}
        {question.calculate && (
          <div>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Calculate</label>
            <XPathField value={question.calculate} getLintContext={getLintContext} onClick={() => setXpathModal({ field: 'calculate', value: question.calculate!, label: 'Calculate' })} />
          </div>
        )}

        {(!question.required || missingXPathFields.length > 0 || missingValidationMsg.length > 0) && (
          <div className={hasContent ? 'pt-2 border-t border-nova-border/40' : ''}>
            <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">Add Property</label>
            <div className="flex flex-wrap gap-1.5">
              {!question.required && (
                <AddPropertyButton label="Required" onClick={() => saveQuestion('required', 'true()')} />
              )}
              {missingValidationMsg.map(({ field, label }) => (
                <AddPropertyButton
                  key={field}
                  label={label}
                  onClick={() => setNewlyAdded({ field, questionPath: selected.questionPath! })}
                />
              ))}
              {missingXPathFields.map(({ field, label }) => (
                <AddPropertyButton
                  key={field}
                  label={label}
                  onClick={() => setXpathModal({ field, value: '', label })}
                />
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
            if (xpathModal.field === 'required') {
              saveQuestion('required', value || 'true()')
            } else {
              saveQuestion(xpathModal.field, value || null)
            }
            setXpathModal(undefined)
          }}
          onClose={() => setXpathModal(undefined)}
          getLintContext={getLintContext}
        />
      )}
    </>
  )
}
