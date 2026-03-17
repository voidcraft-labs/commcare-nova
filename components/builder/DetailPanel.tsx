'use client'
import { useState, useCallback } from 'react'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciCloseMd from '@iconify-icons/ci/close-md'
import ciFileAdd from '@iconify-icons/ci/file-add'
import ciFileEdit from '@iconify-icons/ci/file-edit'
import ciFileBlank from '@iconify-icons/ci/file-blank'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import { deriveCaseConfig, QUESTION_TYPES } from '@/lib/schemas/blueprint'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import { Badge } from '@/components/ui/Badge'
import { XPathField } from '@/components/builder/XPathField'
import { EditableText } from '@/components/builder/EditableText'
import { EditableDropdown } from '@/components/builder/EditableDropdown'
import { XPathEditorModal } from '@/components/builder/XPathEditorModal'

const formTypeIcons = {
  registration: ciFileAdd,
  followup: ciFileEdit,
  survey: ciFileBlank,
} as const

const formTypeOptions = [
  { value: 'registration', label: 'Registration' },
  { value: 'followup', label: 'Followup' },
  { value: 'survey', label: 'Survey' },
]

const questionTypeOptions = QUESTION_TYPES.map(t => ({ value: t, label: t }))

const requiredOptions = [
  { value: '', label: 'Not required' },
  { value: 'true()', label: 'Always required' },
  { value: 'conditional', label: 'Conditional...' },
]

interface DetailPanelProps {
  builder: Builder
}

export function DetailPanel({ builder }: DetailPanelProps) {
  const [xpathModal, setXpathModal] = useState<{ field: string; value: string; label: string } | null>(null)
  const [newlyAdded, setNewlyAdded] = useState<{ field: string; questionPath: string } | null>(null)

  const selected = builder.selected!
  const mb = builder.mb!

  const mod = mb.getModule(selected.moduleIndex)
  if (!mod) return null

  const form = selected.formIndex !== undefined
    ? mb.getForm(selected.moduleIndex, selected.formIndex)
    : null

  const question = selected.questionPath && selected.formIndex !== undefined
    ? mb.getQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath)?.question
    : undefined

  // Mutation helpers — mutate in-place and notify
  const { notifyBlueprintChanged } = builder

  const saveModule = useCallback((updates: { name?: string }) => {
    mb.updateModule(selected.moduleIndex, updates)
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, notifyBlueprintChanged])

  const saveForm = useCallback((updates: { name?: string; type?: 'registration' | 'followup' | 'survey' }) => {
    if (selected.formIndex === undefined) return
    mb.updateForm(selected.moduleIndex, selected.formIndex, updates)
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, notifyBlueprintChanged])

  const saveQuestion = useCallback((field: string, value: string | null) => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
      [field]: value === '' ? null : value,
    })
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])

  const renameCaseProperty = useCallback((oldName: string, newName: string) => {
    if (!newName) return
    const caseType = mod.case_type
    if (!caseType) return
    mb.renameCaseProperty(caseType, oldName, newName)
    notifyBlueprintChanged()
  }, [mb, mod.case_type, notifyBlueprintChanged])

  const renameQuestion = useCallback((newId: string) => {
    if (selected.formIndex === undefined || !selected.questionPath || !newId) return
    mb.renameQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, newId)
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])

  const handleXPathSave = useCallback((value: string) => {
    if (!xpathModal) return
    saveQuestion(xpathModal.field, value || null)
  }, [xpathModal, saveQuestion])

  // Required field special handling
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

  // Determine the required dropdown value
  const requiredValue = !question?.required ? '' : question.required === 'true()' ? 'true()' : 'conditional'

  // XPath fields that can be added
  const xpathFields = [
    { field: 'constraint', label: 'Constraint' },
    { field: 'relevant', label: 'Show When' },
    { field: 'default_value', label: 'Default Value' },
    { field: 'calculate', label: 'Calculate' },
  ] as const

  // Text fields that can be added
  const addableTextFields = [
    { field: 'hint', label: 'Hint' },
    { field: 'constraint_msg', label: 'Constraint Message' },
  ] as const

  // Derive which field (if any) is newly added for the current selection
  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : null
  const clearNewlyAdded = () => setNewlyAdded(null)

  // Compute missing optional fields for "add" affordances
  const missingXPathFields = question
    ? xpathFields.filter(f => !question[f.field as keyof Question])
    : []
  const missingTextFields = question
    ? addableTextFields.filter(f =>
        !question[f.field as keyof Question]
        && newlyAddedField !== f.field
        && !(f.field === 'constraint_msg' && !question.constraint)
      )
    : []

  return (
    <motion.div
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="w-80 border-l border-nova-border bg-nova-deep overflow-y-auto shrink-0"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-nova-border flex items-center justify-between">
        <h3 className="text-sm font-medium text-nova-text-secondary">
          {selected.type === 'module' ? 'Module' : selected.type === 'form' ? 'Form' : 'Question'}
        </h3>
        <button
          onClick={() => builder.select(null)}
          className="text-nova-text-muted hover:text-nova-text transition-colors p-1"
        >
          <Icon icon={ciCloseMd} width="14" height="14" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Module details */}
        {selected.type === 'module' && (
          <>
            <EditableText label="Name" value={mod.name} onSave={(v) => saveModule({ name: v })} />
            {mod.case_type && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Type</label>
                <p className="text-sm font-mono text-nova-cyan-bright">{mod.case_type}</p>
              </div>
            )}
            {mod.case_list_columns && mod.case_list_columns.length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">Case List Columns</label>
                <div className="rounded-lg border border-nova-cyan/10 overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto] bg-nova-cyan/[0.04]">
                    <div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-cyan-bright uppercase">
                      Header
                    </div>
                    <div className="px-3 py-1.5 text-[11px] font-medium tracking-wide text-nova-text-muted uppercase border-l border-nova-cyan/10">
                      Field
                    </div>
                  </div>
                  {mod.case_list_columns.map((col, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto] border-t border-nova-border/40">
                      <div className="px-3 py-1.5 text-sm text-nova-text-secondary">
                        {col.header}
                      </div>
                      <div className="px-3 py-1.5 text-xs font-mono text-nova-text-muted border-l border-nova-border/30">
                        {col.field}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Forms</label>
              <div className="space-y-1">
                {mod.forms.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Icon icon={formTypeIcons[f.type as keyof typeof formTypeIcons] ?? ciFileBlank} width="14" height="14" className="text-nova-text-muted shrink-0" />
                    <span>{f.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Form details */}
        {selected.type === 'form' && form && (
          <>
            <EditableText label="Name" value={form.name} onSave={(v) => saveForm({ name: v })} />
            <EditableDropdown
              label="Type"
              value={form.type}
              options={formTypeOptions}
              onSave={(v) => saveForm({ type: v as 'registration' | 'followup' | 'survey' })}
              renderValue={(v) => (
                <div className="flex items-center gap-2 text-sm">
                  <Icon icon={formTypeIcons[v as keyof typeof formTypeIcons] ?? ciFileBlank} width="14" height="14" className="text-nova-text-muted shrink-0" />
                  <span className="capitalize">{v}</span>
                </div>
              )}
            />
            {(() => {
              const { case_name_field, case_properties, case_preload } = deriveCaseConfig(form.questions || [], form.type)
              return (
                <>
                  {case_name_field && (
                    <div>
                      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Name Field</label>
                      <p className="text-sm font-mono text-nova-cyan-bright">{case_name_field}</p>
                    </div>
                  )}
                  {case_properties && case_properties.length > 0 && (
                    <div>
                      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Properties</label>
                      <div className="space-y-1">
                        {case_properties.map(({ case_property, question_id }) => (
                          <div key={case_property} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                            <span className="text-nova-text-secondary">{case_property}</span>
                            <span className="font-mono text-nova-text-muted">&larr; {question_id}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {case_preload && case_preload.length > 0 && (
                    <div>
                      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Preload</label>
                      <div className="space-y-1">
                        {case_preload.map(({ question_id, case_property }) => (
                          <div key={question_id} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                            <span className="font-mono text-nova-text-muted">{question_id}</span>
                            <span className="text-nova-text-secondary">&larr; {case_property}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
            {form.close_case && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Close Case</label>
                <p className="text-sm text-nova-rose">
                  {form.close_case.question
                    ? `When ${form.close_case.question} = "${form.close_case.answer}"`
                    : 'Always (unconditional)'}
                </p>
              </div>
            )}
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Questions</label>
              <p className="text-sm text-nova-text-secondary">{form.questions?.length || 0} questions</p>
            </div>
          </>
        )}

        {/* Question details */}
        {selected.type === 'question' && question && (
          <>
            {question.label !== undefined && (
              <EditableText
                label="Label"
                value={question.label ?? ''}
                onSave={(v) => saveQuestion('label', v || null)}
                multiline
              />
            )}
            <EditableText
              label="ID"
              value={question.id}
              onSave={renameQuestion}
              mono
              color="text-nova-violet-bright"
            />
            <EditableDropdown
              label="Type"
              value={question.type}
              options={questionTypeOptions}
              onSave={(v) => saveQuestion('type', v)}
              renderValue={(v) => <Badge variant="violet">{v}</Badge>}
            />
            {question.case_property && (
              <EditableText
                label="Case Property"
                value={question.case_property}
                onSave={(v) => v ? renameCaseProperty(question.case_property!, v) : saveQuestion('case_property', null)}
                mono
                color="text-nova-cyan-bright"
              />
            )}
            {question.case_property && question.is_case_name && (
              <div>
                <Badge variant="emerald">case name</Badge>
              </div>
            )}
            {(question.hint || newlyAddedField === 'hint') && (
              <EditableText
                label="Hint"
                value={question.hint ?? ''}
                onSave={(v) => {
                  saveQuestion('hint', v || null)
                  clearNewlyAdded()
                }}
                startEditing={newlyAddedField === 'hint'}
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

            {question.constraint && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Constraint</label>
                <XPathField value={question.constraint} onClick={() => setXpathModal({ field: 'constraint', value: question.constraint!, label: 'Constraint' })} />
                {(question.constraint_msg || newlyAddedField === 'constraint_msg') && (
                  <div className="mt-1">
                    <EditableText
                      label="Constraint Message"
                      value={question.constraint_msg ?? ''}
                      onSave={(v) => {
                        saveQuestion('constraint_msg', v || null)
                        clearNewlyAdded()
                      }}
                      startEditing={newlyAddedField === 'constraint_msg'}
                      onEmpty={newlyAddedField === 'constraint_msg' ? clearNewlyAdded : undefined}
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
            {question.options && question.options.length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Options</label>
                <div className="space-y-1">
                  {question.options.map((opt, i) => (
                    <div key={i} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                      <span>{opt.label}</span>
                      <span className="font-mono text-nova-text-muted">{opt.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add field affordances */}
            {(missingXPathFields.length > 0 || missingTextFields.length > 0) && (
              <div className="pt-2 border-t border-nova-border/40">
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-2 block">Add Property</label>
                <div className="flex flex-wrap gap-1.5">
                  {missingTextFields.map(({ field, label }) => (
                    <button
                      key={field}
                      onClick={() => setNewlyAdded({ field, questionPath: selected.questionPath! })}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors"
                    >
                      <Icon icon={ciAddPlus} width="10" height="10" />
                      {label}
                    </button>
                  ))}
                  {missingXPathFields.map(({ field, label }) => (
                    <button
                      key={field}
                      onClick={() => setXpathModal({ field, value: '', label })}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors"
                    >
                      <Icon icon={ciAddPlus} width="10" height="10" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* XPath editor modal */}
      {xpathModal && (
        <XPathEditorModal
          value={xpathModal.value}
          label={xpathModal.label}
          onSave={handleXPathSave}
          onClose={() => setXpathModal(null)}
        />
      )}
    </motion.div>
  )
}
