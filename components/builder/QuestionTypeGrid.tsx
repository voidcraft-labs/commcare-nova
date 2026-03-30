'use client'
import { Icon } from '@iconify/react'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
import { POPOVER_GLASS, POPOVER_ELEVATED } from '@/lib/styles'
import type { Question } from '@/lib/schemas/blueprint'

/** Types shown in the grid — excludes hidden (rarely manually inserted) */
const GRID_TYPES = [
  'text', 'int', 'decimal', 'date', 'single_select', 'multi_select',
  'geopoint', 'image', 'barcode', 'label',
  'group', 'repeat',
] as const

interface QuestionTypeGridProps {
  onSelect: (type: Question['type']) => void
  /** Currently active type — highlighted in the grid. */
  activeType?: Question['type']
  /** Surface variant. `'glass'` (default) for standalone popovers, `'elevated'` for
   *  popovers stacked above an existing glass surface. */
  variant?: 'glass' | 'elevated'
}

export function QuestionTypeGrid({ onSelect, activeType, variant = 'glass' }: QuestionTypeGridProps) {
  return (
    <div className={`w-52 p-2 grid grid-cols-2 gap-1 ${variant === 'elevated' ? POPOVER_ELEVATED : POPOVER_GLASS}`}>
      {GRID_TYPES.map((type) => {
        const icon = questionTypeIcons[type]
        const isActive = type === activeType
        return (
          <button
            key={type}
            onClick={() => onSelect(type)}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer
              ${isActive
                ? 'bg-nova-violet/15 text-nova-violet-bright'
                : 'text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text'}`}
          >
            {icon && <Icon icon={icon} width="14" height="14" className="shrink-0" />}
            <span className="truncate">{questionTypeLabels[type] ?? type}</span>
          </button>
        )
      })}
    </div>
  )
}
