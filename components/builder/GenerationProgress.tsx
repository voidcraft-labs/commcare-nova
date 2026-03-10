'use client'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciCheck from '@iconify-icons/ci/check'
import ciCloseSm from '@iconify-icons/ci/close-sm'
import { BuilderPhase } from '@/lib/services/builder'

interface GenerationProgressProps {
  phase: BuilderPhase
  message: string
  completed: number
  total: number
  onDismiss?: () => void
}

const baseStages: { key: BuilderPhase; label: string }[] = [
  { key: BuilderPhase.Designing, label: 'Design' },
  { key: BuilderPhase.Modules, label: 'Modules' },
  { key: BuilderPhase.Forms, label: 'Forms' },
  { key: BuilderPhase.Validating, label: 'Validate' },
]

function getStageStatus(stage: BuilderPhase, currentPhase: BuilderPhase): 'done' | 'active' | 'pending' {
  const order = [BuilderPhase.Designing, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validating, BuilderPhase.Fixing, BuilderPhase.Done]
  const stageIdx = order.indexOf(stage)
  const currentIdx = order.indexOf(currentPhase)

  if (currentIdx < 0) return 'pending'
  if (stageIdx < currentIdx) return 'done'
  if (stageIdx === currentIdx) return 'active'
  return 'pending'
}

/** Get the counter text for the active stage */
function getCounter(stage: BuilderPhase, currentPhase: BuilderPhase, completed: number, total: number): string | null {
  if (stage !== currentPhase || total === 0) return null

  if (stage === BuilderPhase.Modules) {
    return `(${Math.min(completed, total)}/${total})`
  }
  if (stage === BuilderPhase.Forms) {
    return `(${Math.min(completed, total)}/${total})`
  }
  return null
}

export function GenerationProgress({ phase, message, completed, total, onDismiss }: GenerationProgressProps) {
  const isDone = phase === BuilderPhase.Done
  const pct = isDone ? 100 : total > 0 ? Math.min((completed / total) * 100, 100) : 0

  // Only show Fix stage if we've reached it
  const stages = phase === BuilderPhase.Fixing
    ? [...baseStages, { key: BuilderPhase.Fixing, label: 'Fix' }]
    : baseStages

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 8, opacity: 0, scale: 0.97, transition: { duration: 0.25, ease: 'easeIn' } }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="relative rounded-xl border border-nova-violet/20 bg-nova-deep/95 backdrop-blur-sm px-5 py-3 shadow-lg shadow-nova-void/50 min-w-[320px]"
    >
      {/* Dismiss button — absolutely positioned, no layout impact */}
      <AnimatePresence>
        {isDone && onDismiss && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2, delay: 0.3 }}
            onClick={onDismiss}
            className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-border hover:border-nova-violet/40 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
          >
            <Icon icon={ciCloseSm} width="12" height="12" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Stage indicators */}
      <div className="flex items-center gap-2">
        {stages.map((stage, i) => {
          const status = getStageStatus(stage.key, phase)
          const counter = getCounter(stage.key, phase, completed, total)

          return (
            <div key={stage.key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-300 ${
                status === 'done' ? 'text-nova-cyan-bright' :
                status === 'active' ? 'text-nova-violet-bright' :
                'text-nova-text-muted'
              }`}>
                {status === 'done' && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                  >
                    <Icon icon={ciCheck} width="10" height="10" />
                  </motion.span>
                )}
                {status === 'active' && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet-bright animate-pulse"
                  />
                )}
                {stage.label}
                {counter && (
                  <span className="text-nova-violet-bright/70 font-normal">{counter}</span>
                )}
              </div>
              <span className={`text-xs transition-colors duration-300 ${
                status === 'done' ? 'text-nova-cyan/40' : 'text-nova-text-muted/40'
              }`}>&mdash;</span>
            </div>
          )
        })}

        {/* Done dot */}
        <AnimatePresence>
          {isDone ? (
            <motion.span
              key="done-check"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.15 }}
              className="text-nova-cyan-bright"
            >
              <Icon icon={ciCheck} width="12" height="12" />
            </motion.span>
          ) : (
            <motion.span
              key="done-pending"
              className="inline-block w-1.5 h-1.5 rounded-full bg-nova-text-muted/30"
            />
          )}
        </AnimatePresence>
      </div>

      {/* Progress bar */}
      <div className="mt-2 h-[2px] rounded-full bg-nova-surface overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{
            background: isDone
              ? 'var(--nova-cyan-bright)'
              : 'linear-gradient(90deg, var(--nova-cyan), var(--nova-violet-bright))',
            boxShadow: isDone
              ? '0 0 10px var(--nova-cyan)'
              : '0 0 8px var(--nova-violet)',
          }}
          initial={{ width: '0%' }}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 100, damping: 20 }}
        />
      </div>

      {/* Status message */}
      <div className="mt-1.5 h-4 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.p
            key={isDone ? '__done__' : message || '__empty__'}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className={`text-[10px] truncate ${
              isDone ? 'text-nova-cyan-bright/70' : 'text-nova-text-muted'
            }`}
          >
            {isDone ? 'Generation complete' : message || 'Starting...'}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
