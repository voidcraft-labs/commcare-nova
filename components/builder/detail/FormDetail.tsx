'use client'
import { useCallback } from 'react'
import { Icon } from '@iconify/react'
import ciFileAdd from '@iconify-icons/ci/file-add'
import ciFileEdit from '@iconify-icons/ci/file-edit'
import ciFileBlank from '@iconify-icons/ci/file-blank'
import type { BlueprintForm } from '@/lib/schemas/blueprint'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
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
 * Form editing sub-panel within the FormSettingsPanel.
 * Displays and allows editing of: form type, close case info, and question count.
 */
export function FormDetail({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormDetailProps) {
  const saveForm = useCallback((updates: { type?: 'registration' | 'followup' | 'survey' }) => {
    mb.updateForm(moduleIndex, formIndex, updates)
    notifyBlueprintChanged()
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  return (
    <>
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
    </>
  )
}
