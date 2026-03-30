'use client'
import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciCheck from '@iconify-icons/ci/check'
import { useDismissRef } from '@/hooks/useDismissRef'

interface EditableDropdownProps {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onSave: (value: string) => void
  renderValue?: (value: string) => React.ReactNode
}

export function EditableDropdown({ label, value, options, onSave, renderValue }: EditableDropdownProps) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const dismissRef = useDismissRef(() => setOpen(false))

  const handleSelect = useCallback((v: string) => {
    setOpen(false)
    onSave(v)
    if (v !== value) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }, [value, onSave])

  const currentLabel = options.find(o => o.value === value)?.label ?? value

  return (
    <div>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
        {label}
        <AnimatePresence>
          {saved && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              <Icon icon={ciCheck} width="12" height="12" className="text-emerald-400" />
            </motion.span>
          )}
        </AnimatePresence>
      </label>
      <div ref={dismissRef} className="relative">
        <div
          onClick={() => setOpen(!open)}
          className="cursor-pointer hover:opacity-80 transition-opacity"
        >
          {renderValue ? renderValue(value) : (
            <span className="text-sm capitalize">{currentLabel}</span>
          )}
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute z-popover top-full mt-1 left-0 min-w-[160px] bg-nova-surface border border-nova-border rounded-lg shadow-lg overflow-hidden"
            >
              {options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleSelect(opt.value)}
                  className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-nova-elevated/80 transition-colors flex items-center gap-2 ${
                    opt.value === value ? 'text-nova-violet-bright' : 'text-nova-text-secondary'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.value === value ? 'bg-nova-violet' : 'bg-transparent'}`} />
                  {opt.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
