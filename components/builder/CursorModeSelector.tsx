/**
 * Three-segment mode selector for the builder toolbar.
 *
 * Replaces the old Design/Preview toggle with three cursor modes:
 * - **Pointer**: live form experience (no edit chrome)
 * - **Text**: click text surfaces to edit inline with WYSIWYG toolbar
 * - **Inspect**: click questions to expand inline settings panel
 *
 * Animated sliding indicator via `layoutId` matches the existing toolbar aesthetic.
 */

'use client'
import { motion } from 'motion/react'
import { Icon, type IconifyIcon } from '@iconify/react/offline'
import tablerHandFinger from '@iconify-icons/tabler/hand-finger'
import tablerCursorText from '@iconify-icons/tabler/cursor-text'
import ciSettingsFilled from '@iconify-icons/ci/settings-filled'
import type { CursorMode } from '@/lib/services/builder'

interface CursorModeSelectorProps {
  mode: CursorMode
  onChange: (mode: CursorMode) => void
}

/** Color per mode — pointer uses emerald (live), text uses violet (content), inspect uses cyan (structure). */
const MODE_COLORS: Record<CursorMode, { bg: string; text: string }> = {
  pointer: { bg: 'bg-nova-emerald/15', text: 'text-nova-emerald' },
  text:    { bg: 'bg-nova-violet/15', text: 'text-nova-violet-bright' },
  inspect: { bg: 'bg-nova-cyan/15', text: 'text-nova-cyan' },
}

const segments: { key: CursorMode; label: string; icon: IconifyIcon }[] = [
  { key: 'pointer', label: 'Pointer', icon: tablerHandFinger },
  { key: 'text',    label: 'Text',    icon: tablerCursorText },
  { key: 'inspect', label: 'Inspect', icon: ciSettingsFilled },
]

export function CursorModeSelector({ mode, onChange }: CursorModeSelectorProps) {
  return (
    <div className="flex items-center h-[34px] bg-nova-deep border border-nova-border rounded-lg p-0.5">
      {segments.map(({ key, label, icon }) => {
        const isActive = mode === key
        const colors = MODE_COLORS[key]
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className="relative h-full px-2.5 text-[13px] font-medium rounded-md transition-colors cursor-pointer"
          >
            {isActive && (
              <motion.div
                layoutId="cursor-mode-indicator"
                className={`absolute inset-0 rounded-md ${colors.bg}`}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <span className={`relative z-10 flex items-center gap-2 ${
              isActive ? colors.text : 'text-nova-text-muted hover:text-nova-text-secondary'
            }`}>
              <Icon icon={icon} width="16" height="16" />
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
