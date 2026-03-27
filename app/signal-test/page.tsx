'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { SignalGridController, type SignalMode } from '@/lib/signalGridController'
import { SignalPanel, signalLabel } from '@/components/chat/SignalPanel'

// Standalone test page — no builder dependency, simulates energy directly.

interface Scenario {
  name: string
  description: string
  run: (setMode: (m: SignalMode) => void, inject: (n: number) => void) => () => void
}

const scenarios: Scenario[] = [
  {
    name: 'Sending',
    description: 'Upward wave — user just hit send, waiting for server response.',
    run: (setMode) => {
      setMode('sending')
      return () => setMode('idle')
    },
  },
  {
    name: 'Reasoning — Slow Trickle',
    description: 'Model is deep in thought. Sparse reasoning tokens every ~500ms.',
    run: (setMode, inject) => {
      setMode('reasoning')
      const id = setInterval(() => inject(8 + Math.random() * 12), 500)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Steady Stream',
    description: 'Model reasoning at a steady clip. ~30-60 chars every 100ms.',
    run: (setMode, inject) => {
      setMode('reasoning')
      const id = setInterval(() => inject(30 + Math.random() * 30), 100)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Burst Pattern',
    description: '"do-do-do-DA" — small trickles punctuated by big reasoning bursts.',
    run: (setMode, inject) => {
      setMode('reasoning')
      let tick = 0
      const id = setInterval(() => {
        tick++
        if (tick % 12 === 0) {
          inject(200 + Math.random() * 150)
        } else {
          inject(3 + Math.random() * 8)
        }
      }, 120)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Long Pause Then Burst',
    description: 'Model thinks silently for 3s, then dumps a big reasoning block. Repeats.',
    run: (setMode, inject) => {
      setMode('reasoning')
      let phase = 0
      const id = setInterval(() => {
        phase++
        if (phase > 25 && phase <= 30) {
          inject(80 + Math.random() * 120)
        }
        if (phase > 30) phase = 0
      }, 120)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Building — Sweep Only',
    description: 'Build pipeline running, no data parts yet. Just the heartbeat sweep.',
    run: (setMode) => {
      setMode('building')
      return () => setMode('idle')
    },
  },
  {
    name: 'Building — Module Completions',
    description: 'Sweep + large bursts every ~2s (simulating module/form done events).',
    run: (setMode, inject) => {
      setMode('building')
      const id = setInterval(() => inject(200), 2000)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Building — Rapid Forms',
    description: 'Forms completing in quick succession — frequent medium bursts.',
    run: (setMode, inject) => {
      setMode('building')
      const id = setInterval(() => inject(100 + Math.random() * 100), 600)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Full Lifecycle',
    description: 'Sending → Reasoning → Building → Done. Complete generation flow.',
    run: (setMode, inject) => {
      setMode('sending')
      const timers: ReturnType<typeof setTimeout>[] = []

      timers.push(setTimeout(() => {
        setMode('reasoning')
      }, 2000))
      const reasoningId = setInterval(() => {
        inject(10 + Math.random() * 40)
      }, 150)

      timers.push(setTimeout(() => {
        clearInterval(reasoningId)
        setMode('building')
      }, 6000))

      timers.push(setTimeout(() => inject(200), 7000))
      timers.push(setTimeout(() => inject(200), 9000))
      timers.push(setTimeout(() => inject(200), 10500))

      timers.push(setTimeout(() => setMode('idle'), 12000))

      return () => {
        clearInterval(reasoningId)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Mode Transitions',
    description: 'Rapidly cycles through modes every 2s to test blending.',
    run: (setMode, inject) => {
      const modes: SignalMode[] = ['sending', 'reasoning', 'building', 'idle']
      let idx = 0
      setMode(modes[0])
      const id = setInterval(() => {
        idx = (idx + 1) % modes.length
        setMode(modes[idx])
        if (modes[idx] === 'reasoning') inject(60)
        if (modes[idx] === 'building') inject(150)
      }, 2000)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
]

export default function SignalTestPage() {
  const [activeScenario, setActiveScenario] = useState<number | null>(null)
  const [mode, setMode] = useState<SignalMode>('idle')
  const [width, setWidth] = useState(280)
  const controllerRef = useRef<SignalGridController | null>(null)
  const energyRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ctrl = new SignalGridController({
      consumeEnergy: () => {
        const e = energyRef.current
        energyRef.current = 0
        return e
      },
    })
    controllerRef.current = ctrl
    ctrl.attach(el)
    ctrl.powerOn()

    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      ctrl.detach()
      controllerRef.current = null
    }
  }, [])

  // Sync mode state → controller
  useEffect(() => {
    const ctrl = controllerRef.current
    if (!ctrl) return
    ctrl.setMode(mode)
    if (mode !== 'idle') ctrl.powerOn()
  }, [mode])

  const inject = useCallback((amount: number) => {
    energyRef.current += amount
  }, [])

  const runScenario = useCallback((index: number) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    setActiveScenario(index)
    energyRef.current = 0
    cleanupRef.current = scenarios[index].run(setMode, inject)
  }, [inject])

  const stopScenario = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    setMode('idle')
    setActiveScenario(null)
  }, [])

  // Resize the controller when width slider changes
  useEffect(() => {
    controllerRef.current?.resize()
  }, [width])

  return (
    <div className="min-h-screen bg-nova-void text-nova-text p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-display font-medium mb-1">Signal Grid Test</h1>
          <p className="text-sm text-nova-text-secondary">
            Simulate different streaming states to tune animation parameters.
          </p>
        </div>

        {/* Width control */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
              Container Width
            </label>
            <span className="text-xs text-nova-text-secondary font-mono">{width}px</span>
          </div>
          <input
            type="range"
            min={120}
            max={700}
            value={width}
            onChange={e => setWidth(Number(e.target.value))}
            className="w-full accent-nova-violet"
            autoComplete="off"
            data-1p-ignore
          />
          <div className="flex gap-2">
            {[
              ['Sidebar', 280],
              ['Centered', 620],
              ['Narrow', 160],
            ].map(([label, w]) => (
              <button
                key={label as string}
                onClick={() => setWidth(w as number)}
                className={`text-xs px-2.5 py-1 rounded border cursor-pointer transition-colors ${
                  width === w
                    ? 'border-nova-violet/40 bg-nova-violet/10 text-nova-text'
                    : 'border-nova-border text-nova-text-muted hover:border-nova-border-bright'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Grid preview */}
        <div className="space-y-2">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Preview
          </label>
          <div
            className="bg-nova-deep border border-nova-border rounded-xl p-4 flex justify-center"
          >
            <div style={{ width }}>
              <SignalPanel active={mode !== 'idle'} label={signalLabel(mode)}>
                <div ref={gridCallbackRef} className="signal-grid" />
              </SignalPanel>
            </div>
          </div>
        </div>

        {/* Manual energy injection */}
        <div className="space-y-2">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Manual Energy Injection
          </label>
          <div className="flex gap-2 flex-wrap">
            {[5, 20, 50, 100, 200, 500].map(amount => (
              <button
                key={amount}
                onClick={() => inject(amount)}
                className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-violet/40 hover:bg-nova-violet/5 transition-colors cursor-pointer font-mono"
              >
                +{amount}
              </button>
            ))}
          </div>
        </div>

        {/* Mode buttons */}
        <div className="space-y-2">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Direct Mode Control
          </label>
          <div className="flex gap-2">
            {(['sending', 'reasoning', 'building', 'idle'] as SignalMode[]).map(m => (
              <button
                key={m}
                onClick={() => {
                  cleanupRef.current?.()
                  cleanupRef.current = null
                  setActiveScenario(null)
                  setMode(m)
                }}
                className={`text-xs px-3 py-1.5 rounded border transition-colors cursor-pointer capitalize font-mono ${
                  mode === m
                    ? 'border-nova-violet/40 bg-nova-violet/10 text-nova-text'
                    : 'border-nova-border text-nova-text-secondary hover:border-nova-violet/40 hover:bg-nova-violet/5'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Scenarios */}
        <div className="space-y-3">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Simulation Scenarios
          </label>
          <div className="grid gap-2">
            {scenarios.map((s, i) => (
              <div
                key={s.name}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                  activeScenario === i
                    ? 'border-nova-violet/40 bg-nova-violet/5'
                    : 'border-nova-border hover:border-nova-border-bright'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-nova-text-muted mt-0.5">{s.description}</div>
                </div>
                {activeScenario === i ? (
                  <button
                    onClick={stopScenario}
                    className="shrink-0 text-xs px-3 py-1.5 rounded border border-nova-rose/40 bg-nova-rose/10 text-nova-rose hover:bg-nova-rose/20 transition-colors cursor-pointer font-mono"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={() => runScenario(i)}
                    className="shrink-0 text-xs px-3 py-1.5 rounded border border-nova-violet/40 bg-nova-violet/10 text-nova-violet-bright hover:bg-nova-violet/20 transition-colors cursor-pointer font-mono"
                  >
                    Run
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
