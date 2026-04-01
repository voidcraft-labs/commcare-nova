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

const formTypeOptions: { value: string; label: string }[] = [
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
 * Displays close case info (read-only).
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
  moduleIndex: number
  formIndex: number
  mb: MutableBlueprint
  notifyBlueprintChanged: () => void
}

/**
 * Clickable form type icon in the form header.
 * Opens a small dropdown to change the form type inline.
 */
export function FormTypeButton({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormTypeButtonProps) {
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
      animRef.current?.animate(
        [
          { opacity: 0, transform: 'scale(0.97) translateY(-4px)' },
          { opacity: 1, transform: 'scale(1) translateY(0)' },
        ],
        { duration: 150, easing: 'ease-out' },
      )
    }
  }, [open])

  const handleSelect = useCallback((type: string) => {
    mb.updateForm(moduleIndex, formIndex, { type: type as 'registration' | 'followup' | 'survey' })
    notifyBlueprintChanged()
    setOpen(false)
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  const icon = formTypeIcons[form.type] ?? formTypeIcons.survey

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        className="p-1.5 rounded-md transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5 shrink-0"
        aria-label="Change form type"
      >
        <Icon icon={icon} width="18" height="18" />
      </button>

      {open && (
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
