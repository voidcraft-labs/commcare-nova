'use client'
import { useRef, useState, useCallback, useSyncExternalStore } from 'react'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciCheck from '@iconify-icons/ci/check'
import { BuilderPhase } from '@/lib/services/builder'

interface GenerationProgressProps {
  phase: BuilderPhase
  statusMessage?: string
  completed: number
  total: number
  mode: 'centered' | 'compact'
  onDone?: () => void
}

/** Display stages — Modules+Forms are combined into "Build" */
const baseStages: { key: string; phases: BuilderPhase[]; label: string }[] = [
  { key: 'data-model', phases: [BuilderPhase.DataModel], label: 'Data Model' },
  { key: 'structure', phases: [BuilderPhase.Structure], label: 'Structure' },
  { key: 'build', phases: [BuilderPhase.Modules, BuilderPhase.Forms], label: 'Build' },
  { key: 'validate', phases: [BuilderPhase.Validate], label: 'Validate' },
]

const phaseOrder = [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix, BuilderPhase.Done]

type StageStatus = 'done' | 'active' | 'error' | 'pending'

function getStageStatus(stagePhases: BuilderPhase[], currentPhase: BuilderPhase): StageStatus {
  const currentIdx = phaseOrder.indexOf(currentPhase)
  if (currentIdx < 0) return 'pending'

  // Stage is active if current phase is any of its phases
  if (stagePhases.includes(currentPhase)) return 'active'

  // Stage is done if current phase is past all of its phases
  const lastPhaseIdx = Math.max(...stagePhases.map(p => phaseOrder.indexOf(p)))
  if (currentIdx > lastPhaseIdx) return 'done'

  return 'pending'
}

/** Map phase to its stage index (0-based among displayed stages, + count for Done). */
function getPhaseStageIndex(phase: BuilderPhase, stageCount: number): number {
  const map: Record<string, number> = {
    [BuilderPhase.DataModel]: 0,
    [BuilderPhase.Structure]: 1,
    [BuilderPhase.Modules]: 2,
    [BuilderPhase.Forms]: 2,
    [BuilderPhase.Validate]: 3,
    [BuilderPhase.Fix]: 4,
    [BuilderPhase.Done]: stageCount, // Done is always last
  }
  return map[phase] ?? 0
}

export function GenerationProgress({ phase, statusMessage, completed, total, mode, onDone }: GenerationProgressProps) {
  const isDone = phase === BuilderPhase.Done
  const isError = phase === BuilderPhase.Error

  // Track the last generating phase so we can show which step failed on error
  const lastActivePhaseRef = useRef(phase)
  if (phase !== BuilderPhase.Error && phase !== BuilderPhase.Idle && phase !== BuilderPhase.Done) {
    lastActivePhaseRef.current = phase
  }

  // Only show Fix stage if we've reached it
  const stages = phase === BuilderPhase.Fix || lastActivePhaseRef.current === BuilderPhase.Fix
    ? [...baseStages, { key: 'fix', phases: [BuilderPhase.Fix], label: 'Fix' }]
    : baseStages

  const isCentered = mode === 'centered'
  const [dismissing, setDismissing] = useState(false)

  // Refs for measuring label centers
  const containerRef = useRef<HTMLDivElement>(null)
  const barElRef = useRef<HTMLDivElement>(null)
  const labelRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [labelCenters, setLabelCenters] = useState<number[]>([])

  const setLabelRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) labelRefs.current.set(idx, el)
    else labelRefs.current.delete(idx)
  }, [])

  // Measure label centers via ref callback + ResizeObserver
  const barRefCallback = useCallback((el: HTMLDivElement | null) => {
    barElRef.current = el
    if (!el) return

    const measure = () => {
      const barRect = el.getBoundingClientRect()
      if (barRect.width === 0) return
      const totalLabels = stages.length + 1 // stages + Done
      const centers: number[] = []
      for (let i = 0; i < totalLabels; i++) {
        const labelEl = labelRefs.current.get(i)
        if (labelEl) {
          const r = labelEl.getBoundingClientRect()
          const centerX = r.left + r.width / 2 - barRect.left
          centers[i] = (centerX / barRect.width) * 100
        }
      }
      setLabelCenters(centers)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stages.length, phase])

  // Compute progress bar width — just snap to the measured center of the active stage
  let pct = 0
  if (isDone) {
    pct = 100
  } else if (labelCenters.length > 0) {
    const stageIdx = getPhaseStageIndex(phase, stages.length)
    pct = labelCenters[stageIdx] ?? 0
  }

  // 3s after completion, trigger the pulse→slide-out dismiss animation.
  // Uses useSyncExternalStore's subscribe lifecycle to manage the timer —
  // when isDone changes the old timer is cleaned up and a new one starts.
  const subscribeToDismiss = useCallback((notify: () => void) => {
    // No auto-dismiss on error — user must dismiss manually or retry
    if (!isDone || isError) {
      setDismissing(false)
      return () => {}
    }
    setDismissing(true)
    return () => {}
  }, [isDone, isError])
  useSyncExternalStore(subscribeToDismiss, () => 0, () => 0)

  return (
    <motion.div
      layout
      layoutId="generation-progress"
      ref={containerRef}
      animate={dismissing
        ? { opacity: 0, y: 30, scale: 0.97 }
        : { opacity: 1, y: 0, scale: 1 }
      }
      transition={dismissing
        ? { duration: 1, ease: [0.4, 0, 0.2, 1] }
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
        {stages.map((stage, i) => {
          // On error, compute status from the last active phase, then mark the active one as 'error'
          let status: StageStatus
          if (isError) {
            status = getStageStatus(stage.phases, lastActivePhaseRef.current)
            if (status === 'active') status = 'error'
          } else {
            status = getStageStatus(stage.phases, phase)
          }

          return (
            <div key={stage.key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 font-medium transition-colors duration-300 ${
                  isCentered ? 'text-sm' : 'text-xs'
                } ${
                  status === 'done' ? 'text-nova-cyan-bright' :
                  status === 'active' ? (isCentered ? 'text-nova-text' : 'text-nova-violet-bright') :
                  status === 'error' ? 'text-nova-rose' :
                  'text-nova-text-muted'
                }`}
              >
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
                {status === 'error' && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    className={`inline-block rounded-full bg-nova-rose ${
                      isCentered ? 'w-2 h-2' : 'w-1.5 h-1.5'
                    }`}
                  />
                )}
                <span ref={setLabelRef(i)}>{stage.label}</span>
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
          }`}
        >
          {isDone && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.15 }}
            >
              <Icon icon={ciCheck} width={isCentered ? 14 : 12} height={isCentered ? 14 : 12} />
            </motion.span>
          )}
          <span ref={setLabelRef(stages.length)}>Done</span>
        </div>
      </div>

      {/* Progress bar — pulses once before dismissing */}
      <div
        ref={barRefCallback}
        className={`rounded-full bg-nova-surface overflow-hidden ${
          isCentered ? 'mt-3 h-[3px]' : 'mt-2 h-[2px]'
        }`}
      >
        <motion.div
          className="h-full rounded-full"
          style={{
            background: isDone
              ? 'var(--nova-cyan-bright)'
              : isError
                ? 'linear-gradient(90deg, var(--nova-cyan), var(--nova-rose))'
                : 'linear-gradient(90deg, var(--nova-cyan), var(--nova-violet-bright))',
            boxShadow: isDone
              ? '0 0 10px var(--nova-cyan)'
              : isError
                ? '0 0 8px var(--nova-rose)'
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

      {/* Error message */}
      {isError && statusMessage && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`text-nova-rose/80 mt-1.5 ${isCentered ? 'text-xs' : 'text-[10px]'}`}
        >
          {statusMessage}
        </motion.p>
      )}

    </motion.div>
  )
}
