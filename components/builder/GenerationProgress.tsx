'use client'
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciCheck from '@iconify-icons/ci/check'
import { BuilderPhase } from '@/lib/services/builder'

interface GenerationProgressProps {
  phase: BuilderPhase
  message: string
  completed: number
  total: number
  mode: 'centered' | 'compact'
  onDone?: () => void
}

/** Display stages — Modules+Forms are combined into "Build" */
const baseStages: { key: string; phases: BuilderPhase[]; label: string }[] = [
  { key: 'planning', phases: [BuilderPhase.Planning], label: 'Planning' },
  { key: 'structure', phases: [BuilderPhase.Designing], label: 'Structure' },
  { key: 'build', phases: [BuilderPhase.Modules, BuilderPhase.Forms], label: 'Build' },
  { key: 'validate', phases: [BuilderPhase.Validating], label: 'Validate' },
]

const phaseOrder = [BuilderPhase.Planning, BuilderPhase.Designing, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validating, BuilderPhase.Fixing, BuilderPhase.Done]

function getStageStatus(stagePhases: BuilderPhase[], currentPhase: BuilderPhase): 'done' | 'active' | 'pending' {
  const currentIdx = phaseOrder.indexOf(currentPhase)
  if (currentIdx < 0) return 'pending'

  // Stage is active if current phase is any of its phases
  if (stagePhases.includes(currentPhase)) return 'active'

  // Stage is done if current phase is past all of its phases
  const lastPhaseIdx = Math.max(...stagePhases.map(p => phaseOrder.indexOf(p)))
  if (currentIdx > lastPhaseIdx) return 'done'

  return 'pending'
}

export function GenerationProgress({ phase, message, completed, total, mode, onDone }: GenerationProgressProps) {
  const isDone = phase === BuilderPhase.Done
  const pct = isDone ? 100 : total > 0 ? Math.min((completed / total) * 100, 100) : 0
  const isCentered = mode === 'centered'
  const [dismissing, setDismissing] = useState(false)

  // Auto-dismiss: 3s after done, trigger the pulse→slide-out sequence
  useEffect(() => {
    if (!isDone) {
      setDismissing(false)
      return
    }
    const timer = setTimeout(() => setDismissing(true), 3000)
    return () => clearTimeout(timer)
  }, [isDone])

  // Only show Fix stage if we've reached it
  const stages = phase === BuilderPhase.Fixing
    ? [...baseStages, { key: 'fix', phases: [BuilderPhase.Fixing], label: 'Fix' }]
    : baseStages

  return (
    <motion.div
      layout
      layoutId="generation-progress"
      animate={dismissing
        ? { opacity: 0, y: 30, scale: 0.97 }
        : { opacity: 1, y: 0, scale: 1 }
      }
      transition={dismissing
        ? { duration: 0.5, ease: [0.4, 0, 0.2, 1] }
        : { layout: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }
      }
      onAnimationComplete={() => {
        if (dismissing) onDone?.()
      }}
      className={`relative rounded-xl shadow-lg backdrop-blur-sm ${
        isCentered
          ? 'border border-nova-violet/30 bg-nova-surface/90 px-8 py-5 shadow-nova-violet/10 min-w-[400px]'
          : 'border border-nova-violet/20 bg-nova-deep/95 px-5 py-3 shadow-nova-void/50 min-w-[360px]'
      }`}
    >
      {/* Stage indicators */}
      <div className={`flex items-center ${isCentered ? 'gap-3' : 'gap-2'}`}>
        {stages.map((stage) => {
          const status = getStageStatus(stage.phases, phase)

          return (
            <div key={stage.key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 font-medium transition-colors duration-300 ${
                isCentered ? 'text-sm' : 'text-xs'
              } ${
                status === 'done' ? 'text-nova-cyan-bright' :
                status === 'active' ? (isCentered ? 'text-nova-text' : 'text-nova-violet-bright') :
                'text-nova-text-muted'
              }`}>
                {status === 'done' && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                  >
                    <Icon icon={ciCheck} width={isCentered ? 12 : 10} height={isCentered ? 12 : 10} />
                  </motion.span>
                )}
                {status === 'active' && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    className={`inline-block rounded-full bg-nova-violet-bright animate-pulse ${
                      isCentered ? 'w-2 h-2' : 'w-1.5 h-1.5'
                    }`}
                  />
                )}
                {stage.label}
              </div>
              <span className={`transition-colors duration-300 ${
                isCentered ? 'text-sm' : 'text-xs'
              } ${
                status === 'done' ? 'text-nova-cyan/40' : 'text-nova-text-muted/40'
              }`}>&mdash;</span>
            </div>
          )
        })}

        {/* Done — always present, lights up when complete */}
        <div className={`flex items-center gap-1.5 font-medium transition-colors duration-300 ${
          isCentered ? 'text-sm' : 'text-xs'
        } ${
          isDone ? 'text-nova-cyan-bright' : 'text-nova-text-muted'
        }`}>
          {isDone && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.15 }}
            >
              <Icon icon={ciCheck} width={isCentered ? 14 : 12} height={isCentered ? 14 : 12} />
            </motion.span>
          )}
          Done
        </div>
      </div>

      {/* Progress bar — pulses once before dismissing */}
      <div className={`rounded-full bg-nova-surface overflow-hidden ${
        isCentered ? 'mt-3 h-[3px]' : 'mt-2 h-[2px]'
      }`}>
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
          animate={dismissing
            ? { width: '100%', opacity: [1, 0.4, 1] }
            : { width: `${pct}%` }
          }
          transition={dismissing
            ? { opacity: { duration: 0.4, ease: 'easeInOut' } }
            : { type: 'spring', stiffness: 100, damping: 20 }
          }
        />
      </div>

      {/* Status message */}
      <div className={`overflow-hidden ${isCentered ? 'mt-2 h-5' : 'mt-1.5 h-4'}`}>
        <AnimatePresence mode="wait">
          <motion.p
            key={isDone ? '__done__' : message || '__empty__'}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className={`truncate ${
              isCentered ? 'text-xs' : 'text-[10px]'
            } ${
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
