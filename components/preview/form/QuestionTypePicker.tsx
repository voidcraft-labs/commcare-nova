'use client'
import { useCallback } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Icon } from '@iconify/react'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { useEditContext } from '@/hooks/useEditContext'
import { type QuestionPath, qpath } from '@/lib/services/questionPath'
import { useDismissRef } from '@/hooks/useDismissRef'
import type { Question } from '@/lib/schemas/blueprint'

/** Types shown in the picker — excludes hidden (rarely manually inserted) */
const PICKER_TYPES = [
  'text', 'int', 'decimal', 'date', 'single_select', 'multi_select',
  'geopoint', 'image', 'barcode', 'label',
  'group', 'repeat',
] as const

interface QuestionTypePickerProps {
  anchorEl: HTMLElement
  atIndex: number
  parentPath?: QuestionPath
  onClose: () => void
}

export function QuestionTypePicker({ anchorEl, atIndex, parentPath, onClose }: QuestionTypePickerProps) {
  const ctx = useEditContext()!
  const { builder, moduleIndex, formIndex } = ctx
  const mb = builder.mb!
  const dismissRef = useDismissRef(onClose)

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    elements: { reference: anchorEl },
    whileElementsMounted: autoUpdate,
  })

  const composedRef = useCallback((el: HTMLDivElement | null) => {
    refs.setFloating(el)
    if (!el) return
    const cleanup = dismissRef(el)
    return () => {
      cleanup?.()
      refs.setFloating(null as unknown as HTMLDivElement)
    }
  }, [refs, dismissRef])

  const handleSelect = (type: Question['type']) => {
    // Generate unique ID
    const form = mb.getForm(moduleIndex, formIndex)
    const existingIds = new Set<string>()
    const collectIds = (qs: any[]) => {
      for (const q of qs) {
        existingIds.add(q.id)
        if (q.children) collectIds(q.children)
      }
    }
    if (form?.questions) collectIds(form.questions)

    let newId = `new_${type}`
    if (existingIds.has(newId)) {
      let counter = 2
      while (existingIds.has(`new_${type}_${counter}`)) counter++
      newId = `new_${type}_${counter}`
    }

    const isSelect = type === 'single_select' || type === 'multi_select'
    const defaultOptions = isSelect
      ? [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }]
      : undefined
    mb.addQuestion(moduleIndex, formIndex, { id: newId, type, label: 'New Question', options: defaultOptions }, { atIndex, parentPath })
    builder.notifyBlueprintChanged()
    const newPath = qpath(newId, parentPath)
    builder.markNewQuestion(newPath)
    builder.select({ type: 'question', moduleIndex, formIndex, questionPath: newPath })
    onClose()
  }

  return (
    <FloatingPortal>
      <div
        ref={composedRef}
        style={floatingStyles}
        className="z-popover w-52 rounded-xl bg-nova-deep border border-nova-border shadow-xl p-2 grid grid-cols-2 gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {PICKER_TYPES.map((type) => {
          const icon = questionTypeIcons[type]
          return (
            <button
              key={type}
              onClick={() => handleSelect(type)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text transition-colors cursor-pointer"
            >
              {icon && <Icon icon={icon} width="14" height="14" className="shrink-0" />}
              <span className="truncate">{questionTypeLabels[type] ?? type}</span>
            </button>
          )
        })}
      </div>
    </FloatingPortal>
  )
}
