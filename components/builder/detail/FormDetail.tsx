'use client'
import { useCallback } from 'react'
import { Icon } from '@iconify/react'
import ciFileAdd from '@iconify-icons/ci/file-add'
import ciFileEdit from '@iconify-icons/ci/file-edit'
import ciFileBlank from '@iconify-icons/ci/file-blank'
import { deriveCaseConfig } from '@/lib/schemas/blueprint'
import type { BlueprintForm } from '@/lib/schemas/blueprint'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { EditableText } from '@/components/builder/EditableText'
import { EditableDropdown } from '@/components/builder/EditableDropdown'

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

interface FormDetailProps {
  /** The form being edited. */
  form: BlueprintForm
  /** Module index in the blueprint. */
  moduleIndex: number
  /** Form index within the module. */
  formIndex: number
  /** The MutableBlueprint instance for direct mutation. */
  mb: MutableBlueprint
  /** Notify the builder that the blueprint has changed. */
  notifyBlueprintChanged: () => void
}

/**
 * Form editing sub-panel within the DetailPanel.
 * Displays and allows editing of: form name, form type, derived case config
 * (case name field, case properties, case preload), close case info, and question count.
 */
export function FormDetail({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormDetailProps) {
  const saveForm = useCallback((updates: { name?: string; type?: 'registration' | 'followup' | 'survey' }) => {
    mb.updateForm(moduleIndex, formIndex, updates)
    notifyBlueprintChanged()
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  return (
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
        const mod = mb.getModule(moduleIndex)
        const bp = mb.getBlueprint()
        const { case_name_field, case_properties, case_preload } = deriveCaseConfig(
          form.questions || [], form.type, mod?.case_type, bp.case_types,
        )
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
  )
}
