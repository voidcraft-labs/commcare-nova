'use client'
import { motion } from 'motion/react'
import { Icon, type IconifyIcon } from '@iconify/react'
import tablerListTree from '@iconify-icons/tabler/list-tree'
import ciEditPencil01 from '@iconify-icons/ci/edit-pencil-01'
import tablerPlayerPlay from '@iconify-icons/tabler/player-play'

interface PreviewToggleProps {
  mode: 'tree' | 'design' | 'preview'
  onChange: (mode: 'tree' | 'design' | 'preview') => void
}

const segments: { key: 'tree' | 'design' | 'preview'; label: string; icon?: IconifyIcon }[] = [
  { key: 'tree', label: 'Tree', icon: tablerListTree },
  { key: 'design', label: 'Design', icon: ciEditPencil01 },
  { key: 'preview', label: 'Preview', icon: tablerPlayerPlay },
]

export function PreviewToggle({ mode, onChange }: PreviewToggleProps) {
  return (
    <div className="flex items-center h-[48px] bg-nova-deep border border-nova-border rounded-lg p-0.5">
      {segments.map(({ key, label, icon }) => {
        const isActive = mode === key
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className="relative h-full px-3.5 text-[13px] font-medium rounded-md transition-colors cursor-pointer"
          >
            {isActive && (
              <motion.div
                layoutId="preview-toggle-indicator"
                className={`absolute inset-0 rounded-md ${
                  key === 'preview' ? 'bg-nova-emerald/15' : 'bg-nova-surface'
                }`}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <span className={`relative z-10 flex items-center gap-2 ${
              isActive
                ? key === 'preview' ? 'text-nova-emerald' : 'text-nova-text'
                : 'text-nova-text-muted hover:text-nova-text-secondary'
            }`}>
              {icon && <Icon icon={icon} width="16" height="16" />}
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
