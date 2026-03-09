'use client'
import { motion } from 'motion/react'
import type { BuilderPhase } from '@/lib/types'

const stages: { key: BuilderPhase; label: string }[] = [
  { key: 'scaffolding', label: 'Scaffold' },
  { key: 'modules', label: 'Modules' },
  { key: 'forms', label: 'Forms' },
  { key: 'validating', label: 'Validate' },
  { key: 'fixing', label: 'Fix' },
  { key: 'compiling', label: 'Compile' },
]

function getStageStatus(stage: BuilderPhase, currentPhase: BuilderPhase): 'done' | 'active' | 'pending' {
  const order = stages.map(s => s.key)
  const stageIdx = order.indexOf(stage)
  const currentIdx = order.indexOf(currentPhase)

  if (currentIdx < 0) return 'pending'
  if (stageIdx < currentIdx) return 'done'
  if (stageIdx === currentIdx) return 'active'
  return 'pending'
}

export function GenerationProgress({ phase, message }: { phase: BuilderPhase; message: string }) {
  return (
    <motion.div
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="border-t border-nova-border bg-nova-deep px-4 py-3 flex items-center gap-4 shrink-0"
    >
      <div className="flex items-center gap-1.5">
        {stages.map((stage) => {
          const status = getStageStatus(stage.key, phase)
          return (
            <div key={stage.key} className="flex items-center gap-1.5">
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                status === 'done' ? 'text-nova-emerald' :
                status === 'active' ? 'text-nova-violet-bright bg-nova-violet/10' :
                'text-nova-text-muted'
              }`}>
                {status === 'done' && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
                {status === 'active' && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet-bright animate-pulse" />
                )}
                {stage.label}
              </div>
              {stage.key !== 'compiling' && (
                <span className="text-nova-text-muted text-xs">&rarr;</span>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex-1 text-right">
        <span className="text-xs text-nova-text-secondary">{message}</span>
      </div>
    </motion.div>
  )
}
