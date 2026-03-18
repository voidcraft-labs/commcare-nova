'use client'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import tablerPlayerPlay from '@iconify-icons/tabler/player-play'
import tablerPlayerPlayFilled from '@iconify-icons/tabler/player-play-filled'

interface PreviewToggleProps {
  mode: 'tree' | 'preview' | 'test'
  onChange: (mode: 'tree' | 'preview' | 'test') => void
}

export function PreviewToggle({ mode, onChange }: PreviewToggleProps) {
  const isPreviewActive = mode === 'preview' || mode === 'test'

  return (
    <div className="flex items-center h-[34px] bg-nova-deep border border-nova-border rounded-lg p-0.5">
      {/* Tree View button */}
      <button
        onClick={() => onChange('tree')}
        className="relative h-full px-2.5 text-xs font-medium rounded-md transition-colors cursor-pointer"
      >
        {mode === 'tree' && (
          <motion.div
            layoutId="preview-toggle-indicator"
            className="absolute inset-0 bg-nova-surface rounded-md"
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          />
        )}
        <span className={`relative z-10 ${mode === 'tree' ? 'text-nova-text' : 'text-nova-text-muted hover:text-nova-text-secondary'}`}>
          Tree View
        </span>
      </button>

      {/* Preview button with integrated test sub-button */}
      <button
        onClick={() => onChange('preview')}
        className="relative h-full px-2.5 text-xs font-medium rounded-md transition-colors cursor-pointer"
      >
        {isPreviewActive && (
          <motion.div
            layoutId="preview-toggle-indicator"
            className="absolute inset-0 bg-nova-surface rounded-md"
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          />
        )}
        <span className={`relative z-10 flex items-center gap-1.5 ${isPreviewActive ? 'text-nova-text' : 'text-nova-text-muted hover:text-nova-text-secondary'}`}>
          Preview
          {/* Test sub-button — only shown when preview is active */}
          {isPreviewActive && (
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation()
                onChange(mode === 'test' ? 'preview' : 'test')
              }}
              className={`inline-flex items-center justify-center w-5 h-5 rounded transition-colors ${
                mode === 'test'
                  ? 'bg-nova-emerald/25 text-nova-emerald'
                  : 'text-nova-text-muted hover:text-nova-text'
              }`}
              title={mode === 'test' ? 'Exit test mode' : 'Test form'}
            >
              <Icon icon={mode === 'test' ? tablerPlayerPlayFilled : tablerPlayerPlay} width="11" height="11" />
            </span>
          )}
        </span>
      </button>
    </div>
  )
}
