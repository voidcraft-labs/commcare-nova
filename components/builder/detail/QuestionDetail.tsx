'use client'
import { useState, useCallback, useRef } from 'react'
import { Icon } from '@iconify/react'
import ciAddPlus from '@iconify-icons/ci/add-plus'
import ciTrashFull from '@iconify-icons/ci/trash-full'
import { QUESTION_TYPES } from '@/lib/schemas/blueprint'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import type { SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { flattenQuestionPaths } from '@/lib/services/questionNavigation'
import type { QuestionPath } from '@/lib/services/questionPath'
import { Badge } from '@/components/ui/Badge'
import { XPathField } from '@/components/builder/XPathField'
import { EditableText } from '@/components/builder/EditableText'
import { EditableDropdown } from '@/components/builder/EditableDropdown'
import { XPathEditorModal } from '@/components/builder/XPathEditorModal'

// ── OptionsEditor ───────────────────────────────────────────────────────

interface OptionsEditorProps {
  options: Array<{ value: string; label: string }>
  onSave: (options: Array<{ value: string; label: string }>) => void
}

function OptionsEditor({ options, onSave }: OptionsEditorProps) {
  const [draft, setDraft] = useState<Array<{ value: string; label: string }>>(options)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)

  // Sync draft when options change externally (e.g. undo/redo or question switch)
  const optionsKey = JSON.stringify(options)
  const prevKeyRef = useRef(optionsKey)
  if (optionsKey !== prevKeyRef.current) {
    prevKeyRef.current = optionsKey
    setDraft(options)
    setFocusIndex(null)
  }

  const commit = useCallback((updated: Array<{ value: string; label: string }>) => {
    // Filter out completely empty options
    const cleaned = updated.filter(o => o.label.trim() || o.value.trim())
    onSave(cleaned)
  }, [onSave])

  const updateOption = useCallback((index: number, field: 'label' | 'value', val: string) => {
    setDraft(prev => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: val }
      return next
    })
  }, [])

  const removeOption = useCallback((index: number) => {
    const next = draft.filter((_, i) => i !== index)
    setDraft(next)
    commit(next)
  }, [draft, commit])

  const addOption = useCallback(() => {
    const num = draft.length + 1
    const next = [...draft, { value: `option_${num}`, label: `Option ${num}` }]
    setDraft(next)
    commit(next)
    setFocusIndex(next.length - 1)
  }, [draft])

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Only commit when focus leaves the entire options editor
    const container = e.currentTarget
    requestAnimationFrame(() => {
      if (!container.contains(document.activeElement)) {
        commit(draft)
        setFocusIndex(null)
      }
    })
  }, [draft, commit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
      commit(draft)
    }
  }, [draft, commit])

  return (
    <div onBlur={handleBlur}>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Options</label>
      <div className="space-y-1.5">
        {draft.map((opt, i) => (
          <div key={i} className="flex items-center gap-1.5 group">
            <div className="flex-1 min-w-0 flex gap-1">
              <input
                value={opt.label}
                onChange={(e) => updateOption(i, 'label', e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Label"
                autoFocus={focusIndex === i}
                className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-nova-surface border border-transparent focus:border-nova-violet/60 text-nova-text outline-none transition-colors"
                autoComplete="off"
                data-1p-ignore
              />
              <input
                value={opt.value}
                onChange={(e) => updateOption(i, 'value', e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="value"
                className="w-24 shrink-0 text-xs font-mono px-2 py-1 rounded bg-nova-surface border border-transparent focus:border-nova-violet/60 text-nova-text-muted outline-none transition-colors"
                autoComplete="off"
                data-1p-ignore
              />
            </div>
            <button
              onClick={() => removeOption(i)}
              className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
              tabIndex={-1}
            >
              <Icon icon={ciTrashFull} width="12" height="12" />
            </button>
          </div>
        ))}
      </div>
      <button
        ref={addRef}
        onClick={addOption}
        className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer"
      >
        <Icon icon={ciAddPlus} width="10" height="10" />
        Add option
      </button>
    </div>
  )
}

// ── QuestionDetail helpers ──────────────────────────────────────────────

const questionTypeOptions = QUESTION_TYPES.map(t => ({ value: t, label: t }))

const requiredOptions = [
  { value: '', label: 'Not required' },
  { value: 'true()', label: 'Always required' },
  { value: 'conditional', label: 'Conditional...' },
]

// XPath fields that can be added
const xpathFields = [
  { field: 'validation', label: 'Validation' },
  { field: 'relevant', label: 'Show When' },
  { field: 'default_value', label: 'Default Value' },
  { field: 'calculate', label: 'Calculate' },
] as const

// Text fields that can be added
const addableTextFields = [
  { field: 'hint', label: 'Hint' },
  { field: 'validation_msg', label: 'Validation Message' },
] as const

interface QuestionDetailProps {
  /** The question being edited. */
  question: Question
  /** The current selection state. */
  selected: SelectedElement
  /** The MutableBlueprint instance for direct mutation. */
  mb: MutableBlueprint
  /** The builder instance, used for selection and new-question state. */
  builder: Builder
  /** Notify the builder that the blueprint has changed. */
  notifyBlueprintChanged: () => void
}

/**
 * Question editing sub-panel within the DetailPanel.
 * Displays and allows editing of: label, ID, type, case property, hint, required,
 * validation/relevant/default_value/calculate (XPath fields), options, and add/delete affordances.
 *
 * Renders three sibling sections designed for the DetailPanel's flex-col layout:
 * 1. Scrollable field content (inside the flex-1 overflow area)
 * 2. Delete bar (sticky bottom, shrink-0)
 * 3. XPath editor modal (portal-mounted)
 */
export function QuestionDetail({ question, selected, mb, builder, notifyBlueprintChanged }: QuestionDetailProps) {
  const [xpathModal, setXpathModal] = useState<{ field: string; value: string; label: string }>()
  const [newlyAdded, setNewlyAdded] = useState<{ field: string; questionPath: QuestionPath }>()

  const saveQuestion = useCallback((field: string, value: string | null) => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
      [field]: value === '' ? null : value,
    })
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])

  const renameCaseProperty = useCallback((oldName: string, newName: string) => {
    if (!newName) return
    const mod = mb.getModule(selected.moduleIndex)
    const caseType = mod?.case_type
    if (!caseType) return
    mb.renameCaseProperty(caseType, oldName, newName)
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, notifyBlueprintChanged])

  const renameQuestion = useCallback((newId: string) => {
    if (selected.formIndex === undefined || !selected.questionPath || !newId) return
    const { newPath } = mb.renameQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, newId)
    builder.select({ ...selected, questionPath: newPath })
    notifyBlueprintChanged()
  }, [mb, selected, builder, notifyBlueprintChanged])

  const deleteQuestion = useCallback(() => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    const form = mb.getForm(selected.moduleIndex, selected.formIndex)
    if (!form) return
    const paths = flattenQuestionPaths(form.questions)
    const curIdx = paths.indexOf(selected.questionPath as QuestionPath)
    const nextPath = paths[curIdx + 1] ?? paths[curIdx - 1]

    mb.removeQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath)
    notifyBlueprintChanged()

    if (nextPath) {
      builder.select({ type: 'question', moduleIndex: selected.moduleIndex, formIndex: selected.formIndex!, questionPath: nextPath })
    } else {
      builder.select()
    }
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, builder, notifyBlueprintChanged])

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

  // Derive which field (if any) is newly added for the current selection
  const newlyAddedField = newlyAdded && newlyAdded.questionPath === selected.questionPath ? newlyAdded.field : undefined
  const clearNewlyAdded = () => setNewlyAdded(undefined)

  // Compute missing optional fields for "add" affordances
  const missingXPathFields = xpathFields.filter(f => !question[f.field as keyof Question])
  const missingTextFields = addableTextFields.filter(f =>
    !question[f.field as keyof Question]
    && newlyAddedField !== f.field
    && !(f.field === 'validation_msg' && !question.validation)
  )

  return (
    <>
      {/* Scrollable field content */}
      <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
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
        <EditableText
          label="ID"
          value={question.id}
          onSave={(v) => { renameQuestion(v); builder.clearNewQuestion() }}
          mono
          color="text-nova-violet-bright"
          selectAll={builder.isNewQuestion(selected.questionPath!)}
        />
        <EditableDropdown
          label="Type"
          value={question.type}
          options={questionTypeOptions}
          onSave={(v) => saveQuestion('type', v)}
          renderValue={(v) => <Badge variant="violet">{v}</Badge>}
        />
        {question.is_case_property && (
          <div className="flex items-center gap-2">
            <Badge variant="cyan">case property</Badge>
            {question.id === 'case_name' && <Badge variant="emerald">case name</Badge>}
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
        {(question.type === 'single_select' || question.type === 'multi_select') && (
          <OptionsEditor
            options={question.options ?? []}
            onSave={(options) => {
              if (selected.formIndex === undefined || !selected.questionPath) return
              mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
                options: options.length > 0 ? options : null,
              })
              notifyBlueprintChanged()
            }}
          />
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
      </div>

      {/* Delete bar — sticky bottom, background only visible when content scrolls behind it */}
      <div className="shrink-0 px-4 py-3 bg-nova-deep flex justify-start">
        <button
          onClick={deleteQuestion}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm text-nova-rose hover:text-white hover:bg-nova-rose/20 transition-colors cursor-pointer rounded"
        >
          <Icon icon={ciTrashFull} width="14" height="14" />
          Delete
        </button>
      </div>

      {/* XPath editor modal */}
      {xpathModal && (
        <XPathEditorModal
          value={xpathModal.value}
          label={xpathModal.label}
          onSave={handleXPathSave}
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
