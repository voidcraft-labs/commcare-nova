'use client'
import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciDownload from '@iconify-icons/ci/download'
import ciChevronDown from '@iconify-icons/ci/chevron-down'
import { useDismissRef } from '@/hooks/useDismissRef'

interface DownloadOption {
  label: string
  description: string
  icon: React.ReactNode
  onClick: () => void
}

interface DownloadDropdownProps {
  options: DownloadOption[]
}

export function DownloadDropdown({ options }: DownloadDropdownProps) {
  const [open, setOpen] = useState(false)
  const dismissRef = useDismissRef(() => setOpen(false))

  return (
    <div ref={dismissRef} className="relative">
      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-lg font-medium rounded-lg bg-nova-surface text-nova-text border border-nova-border hover:border-nova-border-bright hover:bg-nova-elevated transition-all duration-200 cursor-pointer"
      >
        <Icon icon={ciDownload} width="14" height="14" className="opacity-70" />
        Download
        <Icon
          icon={ciChevronDown}
          width="10" height="10"
          className={`opacity-50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="absolute right-0 top-[calc(100%+6px)] z-popover w-52 rounded-xl border border-nova-border-bright bg-nova-surface/95 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.5)] overflow-hidden"
          >
            {options.map((option, i) => (
              <button
                key={i}
                onClick={() => { option.onClick(); setOpen(false) }}
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-nova-elevated/80 transition-colors duration-150 cursor-pointer group"
              >
                <span className="shrink-0 self-center text-nova-text-secondary group-hover:text-nova-violet-bright transition-colors duration-150">
                  {option.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-nova-text">{option.label}</div>
                  <div className="text-xs text-nova-text-muted leading-tight">{option.description}</div>
                </div>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
