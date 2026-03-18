'use client'
import { useEffect, useRef } from 'react'
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/react'
import { Icon } from '@iconify/react'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { useEditContext } from '@/hooks/useEditContext'

/** Types shown in the picker — excludes hidden (rarely manually inserted) */
const PICKER_TYPES = [
  'text', 'int', 'decimal', 'date', 'select1', 'select',
  'geopoint', 'image', 'phone', 'barcode', 'label',
  'group', 'repeat',
] as const

interface QuestionTypePickerProps {
  anchorEl: HTMLElement
  atIndex: number
  parentId?: string
  onClose: () => void
}

export function QuestionTypePicker({ anchorEl, atIndex, parentId, onClose }: QuestionTypePickerProps) {
  const ctx = useEditContext()!
  const { builder, moduleIndex, formIndex } = ctx
  const mb = builder.mb!
  const panelRef = useRef<HTMLDivElement>(null)

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    elements: { reference: anchorEl },
    whileElementsMounted: autoUpdate,
  })

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleSelect = (type: string) => {
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

    mb.addQuestion(moduleIndex, formIndex, { id: newId, type: type as any, label: 'New Question' }, { atIndex, parentId })
    builder.notifyBlueprintChanged()
    builder.autoFocusLabel = true
    builder.select({ type: 'question', moduleIndex, formIndex, questionPath: newId })
    onClose()
  }

  return (
    <div
      ref={(el) => { refs.setFloating(el); (panelRef as any).current = el }}
      style={floatingStyles}
      className="z-50 w-52 rounded-xl bg-nova-deep border border-nova-border shadow-xl p-2 grid grid-cols-2 gap-1"
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
  )
}
