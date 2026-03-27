'use client'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { SignalMode } from '@/lib/signalGridController'

/** Default mode → label mapping. */
export function signalLabel(mode: SignalMode): string {
  switch (mode) {
    case 'sending': return 'Transmitting'
    case 'reasoning': return 'Thinking'
    case 'building': return 'Building'
    case 'idle': return ''
  }
}

interface SignalPanelProps {
  active: boolean
  /** Base label (e.g. "Thinking") — used as the crossfade key. */
  label: string
  /** Full display text including timer suffix (e.g. "Thinking (32s)"). Rendered inside the crossfade. */
  displayLabel?: string
  children: ReactNode
}

/** Sci-fi panel chrome — bezels, notches, indicator LED, display well, etched label. */
export function SignalPanel({ active, label, displayLabel, children }: SignalPanelProps) {
  const baseText = label && active ? label : 'SYS:IDLE'
  const displayText = displayLabel && active ? displayLabel : baseText

  return (
    <div className="nova-panel" data-active={active || undefined}>
      {/* Top bezel — etched groove with corner notches */}
      <div className="nova-panel-bezel nova-panel-bezel-top">
        <div className="nova-panel-notch" />
        <div className="nova-panel-groove" />
        <div className={`nova-panel-indicator ${active ? 'active' : ''}`} />
        <div className="nova-panel-groove" />
        <div className="nova-panel-notch" />
      </div>

      {/* Display well — the recessed area where the LEDs sit */}
      <div className="nova-panel-well">
        {children}
      </div>

      {/* Bottom bezel — label etched into the frame */}
      <div className="nova-panel-bezel nova-panel-bezel-bottom">
        <div className="nova-panel-groove" />
        <AnimatePresence mode="wait">
          <motion.span
            key={baseText}
            className="nova-panel-etch"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.75 }}
          >
            {displayText}
          </motion.span>
        </AnimatePresence>
        <div className="nova-panel-groove" />
      </div>
    </div>
  )
}
