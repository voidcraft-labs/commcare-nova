'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { SignalGridController, type SignalMode } from '@/lib/signalGridController'

// Standalone test page — no builder dependency, simulates energy directly.

interface Scenario {
  name: string
  description: string
  run: (ctrl: SignalGridController, inject: (n: number) => void) => () => void
}

const scenarios: Scenario[] = [
  {
    name: 'Sending',
    description: 'Upward wave — user just hit send, waiting for server response.',
    run: (ctrl) => {
      ctrl.setMode('sending')
      return () => ctrl.setMode('idle')
    },
  },
  {
    name: 'Reasoning — Slow Trickle',
    description: 'Model is deep in thought. Sparse reasoning tokens every ~500ms.',
    run: (ctrl, inject) => {
      ctrl.setMode('reasoning')
      const id = setInterval(() => inject(8 + Math.random() * 12), 500)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Steady Stream',
    description: 'Model reasoning at a steady clip. ~30-60 chars every 100ms.',
    run: (ctrl, inject) => {
      ctrl.setMode('reasoning')
      const id = setInterval(() => inject(30 + Math.random() * 30), 100)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Burst Pattern',
    description: '"do-do-do-DA" — small trickles punctuated by big reasoning bursts.',
    run: (ctrl, inject) => {
      ctrl.setMode('reasoning')
      let tick = 0
      const id = setInterval(() => {
        tick++
        if (tick % 12 === 0) {
          // Big burst
          inject(200 + Math.random() * 150)
        } else {
          // Small trickle
          inject(3 + Math.random() * 8)
        }
      }, 120)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Long Pause Then Burst',
    description: 'Model thinks silently for 3s, then dumps a big reasoning block. Repeats.',
    run: (ctrl, inject) => {
      ctrl.setMode('reasoning')
      let phase = 0
      const id = setInterval(() => {
        phase++
        if (phase > 25 && phase <= 30) {
          inject(80 + Math.random() * 120) // burst window
        }
        if (phase > 30) phase = 0 // reset cycle
      }, 120)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Building — Sweep Only',
    description: 'Build pipeline running, no data parts yet. Just the heartbeat sweep.',
    run: (ctrl) => {
      ctrl.setMode('building')
      return () => ctrl.setMode('idle')
    },
  },
  {
    name: 'Building — Module Completions',
    description: 'Sweep + large bursts every ~2s (simulating module/form done events).',
    run: (ctrl, inject) => {
      ctrl.setMode('building')
      const id = setInterval(() => inject(200), 2000)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Building — Rapid Forms',
    description: 'Forms completing in quick succession — frequent medium bursts.',
    run: (ctrl, inject) => {
      ctrl.setMode('building')
      const id = setInterval(() => inject(100 + Math.random() * 100), 600)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
  {
    name: 'Full Lifecycle',
    description: 'Sending → Reasoning → Building → Done. Complete generation flow.',
    run: (ctrl, inject) => {
      ctrl.setMode('sending')
      const timers: ReturnType<typeof setTimeout>[] = []

      // 2s: switch to reasoning with trickle
      timers.push(setTimeout(() => {
        ctrl.setMode('reasoning')
      }, 2000))
      const reasoningId = setInterval(() => {
        inject(10 + Math.random() * 40)
      }, 150)

      // 6s: switch to building
      timers.push(setTimeout(() => {
        clearInterval(reasoningId)
        ctrl.setMode('building')
      }, 6000))

      // 7s, 9s, 10.5s: module completions
      timers.push(setTimeout(() => inject(200), 7000))
      timers.push(setTimeout(() => inject(200), 9000))
      timers.push(setTimeout(() => inject(200), 10500))

      // 12s: done
      timers.push(setTimeout(() => ctrl.setMode('idle'), 12000))

      return () => {
        clearInterval(reasoningId)
        timers.forEach(clearTimeout)
        ctrl.setMode('idle')
      }
    },
  },
  {
    name: 'Mode Transitions',
    description: 'Rapidly cycles through modes every 2s to test blending.',
    run: (ctrl, inject) => {
      const modes: SignalMode[] = ['sending', 'reasoning', 'building', 'idle']
      let idx = 0
      ctrl.setMode(modes[0])
      const id = setInterval(() => {
        idx = (idx + 1) % modes.length
        ctrl.setMode(modes[idx])
        if (modes[idx] === 'reasoning') inject(60)
        if (modes[idx] === 'building') inject(150)
      }, 2000)
      return () => { clearInterval(id); ctrl.setMode('idle') }
    },
  },
]

export default function SignalTestPage() {
  const [activeScenario, setActiveScenario] = useState<number | null>(null)
  const [width, setWidth] = useState(280) // default sidebar width
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

  const inject = useCallback((amount: number) => {
    energyRef.current += amount
  }, [])

  const runScenario = useCallback((index: number) => {
    // Cleanup previous
    cleanupRef.current?.()
    cleanupRef.current = null

    const ctrl = controllerRef.current
    if (!ctrl) return

    setActiveScenario(index)
    energyRef.current = 0
    ctrl.powerOn()
    cleanupRef.current = scenarios[index].run(ctrl, inject)
  }, [inject])

  const stopScenario = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    controllerRef.current?.setMode('idle')
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
              <div className="px-1 py-1.5">
                <div ref={gridCallbackRef} className="signal-grid" />
                <div className="text-[10px] text-nova-text-muted tracking-wider mt-1.5 pl-0.5 font-mono uppercase">
                  {activeScenario !== null ? scenarios[activeScenario].name : 'Idle'}
                </div>
              </div>
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
                  controllerRef.current?.setMode(m)
                  if (m !== 'idle') controllerRef.current?.powerOn()
                }}
                className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-violet/40 hover:bg-nova-violet/5 transition-colors cursor-pointer capitalize font-mono"
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
