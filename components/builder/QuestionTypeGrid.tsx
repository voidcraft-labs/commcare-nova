'use client'
import { Icon } from '@iconify/react'
import { questionTypeIcons, questionTypeLabels } from '@/lib/questionTypeIcons'
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
  activeType?: string
}

export function QuestionTypeGrid({ onSelect, activeType }: QuestionTypeGridProps) {
  return (
    <div className="w-52 rounded-xl bg-nova-deep border border-nova-border shadow-xl p-2 grid grid-cols-2 gap-1">
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
