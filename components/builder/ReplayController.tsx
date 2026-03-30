'use client'
import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciCloseMd from '@iconify-icons/ci/close-md'
import { useBuilder } from '@/hooks/useBuilder'
import type { UIMessage } from 'ai'
import type { ReplayStage } from '@/lib/services/logReplay'

interface ReplayControllerProps {
  stages: ReplayStage[]
  appName?: string
  initialIndex?: number
  onExit: () => void
  onMessagesChange: (messages: UIMessage[]) => void
}

export function ReplayController({ stages, appName, initialIndex = 0, onExit, onMessagesChange }: ReplayControllerProps) {
  const builder = useBuilder()
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [error, setError] = useState<string>()

  const goToStage = useCallback((targetIndex: number) => {
    try {
      builder.reset()
      for (let i = 0; i <= targetIndex; i++) {
        stages[i].applyToBuilder(builder)
      }
      onMessagesChange(stages[targetIndex].messages)
      setCurrentIndex(targetIndex)
      setError(undefined)
    } catch (err) {
      setError(`Cannot load stage: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [builder, stages, onMessagesChange])

  const canGoBack = currentIndex > 0
  const canGoForward = currentIndex < stages.length - 1
  const stage = stages[currentIndex]

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-popover flex flex-col items-center gap-2">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="flex items-center gap-3 px-4 py-2 bg-nova-deep/95 backdrop-blur-xl border border-nova-violet-bright/40 rounded-2xl shadow-[0_0_20px_rgba(139,92,246,0.25),0_4px_16px_rgba(0,0,0,0.5)]"
      >
        {/* Left arrow */}
        <button
          onClick={() => canGoBack && goToStage(currentIndex - 1)}
          disabled={!canGoBack}
          className={`p-0.5 rounded-md transition-colors ${
            canGoBack
              ? 'text-nova-text hover:text-nova-violet-bright cursor-pointer'
              : 'text-nova-text-muted cursor-not-allowed'
          }`}
        >
          <Icon icon={ciChevronLeft} width={20} height={20} />
        </button>

        {/* Stage info — fixed width to prevent layout shift */}
        <div className="w-44 select-none flex flex-col justify-center h-9">
          <div className="flex items-center gap-1.5">
            <motion.span
              layout
              className="text-sm font-medium text-nova-text truncate"
              transition={{ duration: 0.2 }}
            >
              {stage.header}
            </motion.span>
            <span className="text-xs text-nova-text-muted shrink-0">
              {currentIndex + 1}/{stages.length}
            </span>
          </div>
          <AnimatePresence>
            {stage.subtitle && (
              <motion.p
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="text-xs text-nova-text-muted truncate overflow-hidden"
              >
                {stage.subtitle}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Right arrow */}
        <button
          onClick={() => canGoForward && goToStage(currentIndex + 1)}
          disabled={!canGoForward}
          className={`p-0.5 rounded-md transition-colors ${
            canGoForward
              ? 'text-nova-text hover:text-nova-violet-bright cursor-pointer'
              : 'text-nova-text-muted cursor-not-allowed'
          }`}
        >
          <Icon icon={ciChevronRight} width={20} height={20} />
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-nova-border" />

        {/* Close */}
        <button
          onClick={onExit}
          className="p-0.5 rounded-md text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
        >
          <Icon icon={ciCloseMd} width={18} height={18} />
        </button>
      </motion.div>

      {/* Error toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onAnimationComplete={() => {
              setTimeout(() => setError(undefined), 3000)
            }}
            className="px-3 py-1.5 bg-nova-rose/15 border border-nova-rose/30 rounded-full text-xs text-rose-400"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
