'use client'
import { motion } from 'motion/react'
import { BuilderPhase } from '@/lib/services/builder'

const stages: { key: BuilderPhase; label: string }[] = [
  { key: BuilderPhase.Modules, label: 'Modules' },
  { key: BuilderPhase.Forms, label: 'Forms' },
  { key: BuilderPhase.Validating, label: 'Validate' },
  { key: BuilderPhase.Fixing, label: 'Fix' },
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
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="rounded-xl border border-nova-violet/20 bg-nova-deep/95 backdrop-blur-sm px-5 py-3 shadow-lg shadow-nova-void/50"
    >
      <div className="flex items-center gap-2">
        {stages.map((stage, i) => {
          const status = getStageStatus(stage.key, phase)
          return (
            <div key={stage.key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                status === 'done' ? 'text-nova-emerald' :
                status === 'active' ? 'text-nova-violet-bright' :
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
              {i < stages.length - 1 && (
                <span className="text-nova-text-muted/40 text-xs">&rarr;</span>
              )}
            </div>
          )
        })}
      </div>
      {message && (
        <p className="text-[10px] text-nova-text-muted mt-1.5">{message}</p>
      )}
    </motion.div>
  )
}
