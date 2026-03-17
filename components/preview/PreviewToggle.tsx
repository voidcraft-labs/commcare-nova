'use client'
import { motion } from 'motion/react'

interface PreviewToggleProps {
  mode: 'tree' | 'preview'
  onChange: (mode: 'tree' | 'preview') => void
}

export function PreviewToggle({ mode, onChange }: PreviewToggleProps) {
  return (
    <div className="flex items-center bg-nova-deep border border-nova-border rounded-lg p-0.5">
      {(['tree', 'preview'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className="relative px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer"
        >
          {mode === m && (
            <motion.div
              layoutId="preview-toggle-indicator"
              className="absolute inset-0 bg-nova-surface rounded-md"
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            />
          )}
          <span className={`relative z-10 ${mode === m ? 'text-nova-text' : 'text-nova-text-muted hover:text-nova-text-secondary'}`}>
            {m === 'tree' ? 'Tree View' : 'Preview'}
          </span>
        </button>
      ))}
    </div>
  )
}
