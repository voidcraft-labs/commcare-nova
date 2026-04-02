'use client'
import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Icon } from '@iconify/react/offline'
import type { BlueprintForm } from '@/lib/schemas/blueprint'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { formTypeIcons } from '@/lib/questionTypeIcons'
import { useDismissRef } from '@/hooks/useDismissRef'
import { useContentPopoverDismiss } from '@/hooks/useContentPopover'
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/DropdownMenu'
import { POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS } from '@/lib/animations'

const formTypeOptions: { value: string; label: string }[] = [
  { value: 'registration', label: 'Registration' },
  { value: 'followup', label: 'Followup' },
  { value: 'survey', label: 'Survey' },
]

interface FormDetailProps {
  /** The form to display close case info for. */
  form: BlueprintForm
}

/**
 * Read-only close case info panel within FormSettingsPanel.
 * Renders only when the form has a close_case configuration.
 */
export function FormDetail({ form }: FormDetailProps) {
  if (!form.close_case) return null

  return (
    <div>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Close Case</label>
      <p className="text-sm text-nova-rose">
        {form.close_case.question
          ? `When ${form.close_case.question} = "${form.close_case.answer}"`
          : 'Always (unconditional)'}
      </p>
    </div>
  )
}

// ── Form Type Button (for FormScreen header) ──────────────────────────

interface FormTypeButtonProps {
  form: BlueprintForm
  /** When provided, the icon becomes a clickable button that opens a type picker. */
  moduleIndex?: number
  formIndex?: number
  mb?: MutableBlueprint
  notifyBlueprintChanged?: () => void
}

/**
 * Form type icon in the form header. Interactive (dropdown to change type) when
 * mutation props are provided, static icon otherwise.
 */
export function FormTypeButton({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormTypeButtonProps) {
  const editable = mb != null && moduleIndex != null && formIndex != null && notifyBlueprintChanged != null
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const animRef = useRef<HTMLDivElement>(null)

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip(),
      shift({ padding: 12 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    if (buttonRef.current) refs.setReference(buttonRef.current)
  }, [refs])

  useLayoutEffect(() => {
    if (open) {
      animRef.current?.animate(POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS)
    }
  }, [open])

  const handleSelect = useCallback((type: string) => {
    if (!editable) return
    mb.updateForm(moduleIndex, formIndex, { type: type as 'registration' | 'followup' | 'survey' })
    notifyBlueprintChanged()
    setOpen(false)
  }, [editable, mb, moduleIndex, formIndex, notifyBlueprintChanged])

  const icon = formTypeIcons[form.type] ?? formTypeIcons.survey

  return (
    <>
      <span
        ref={buttonRef}
        onClick={editable ? () => setOpen(o => !o) : undefined}
        className={`-ml-1.5 p-1.5 rounded-md shrink-0 text-nova-text-muted ${editable ? 'transition-colors cursor-pointer hover:text-nova-text hover:bg-white/5' : ''}`}
        role={editable ? 'button' : undefined}
        aria-label={editable ? 'Change form type' : undefined}
      >
        <Icon icon={icon} width="18" height="18" />
      </span>

      {editable && open && (
        <FloatingPortal>
          <div
            ref={(el) => { animRef.current = el; refs.setFloating(el) }}
            style={floatingStyles}
            className="z-popover"
          >
            <FormTypeDropdown
              currentType={form.type}
              onSelect={handleSelect}
              onClose={() => setOpen(false)}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** Form type dropdown using the shared DropdownMenu for consistent POPOVER_GLASS styling. */
function FormTypeDropdown({ currentType, onSelect, onClose }: { currentType: string; onSelect: (type: string) => void; onClose: () => void }) {
  const dismissRef = useDismissRef(onClose)
  useContentPopoverDismiss(onClose)

  const items: DropdownMenuItem[] = formTypeOptions.map((opt) => ({
    key: opt.value,
    label: opt.label,
    icon: formTypeIcons[opt.value] ?? formTypeIcons.survey,
    onClick: () => onSelect(opt.value),
  }))

  return <DropdownMenu items={items} activeKey={currentType} menuRef={dismissRef} />
}
