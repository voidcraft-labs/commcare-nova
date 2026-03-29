'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { SignalGridController, type SignalMode, type EditFocus } from '@/lib/signalGridController'
import { SignalPanel, signalLabel } from '@/components/chat/SignalPanel'

// Standalone test page — no builder dependency, simulates energy directly.

interface Scenario {
  name: string
  description: string
  run: (ctx: ScenarioContext) => () => void
}

interface ScenarioContext {
  setMode: (m: SignalMode) => void
  inject: (n: number) => void
  injectThink: (n: number) => void
  setFocus: (f: EditFocus | null) => void
}

const scenarios: Scenario[] = [
  {
    name: 'Sending',
    description: 'Upward wave — user just hit send, waiting for server response.',
    run: ({ setMode }) => {
      setMode('sending')
      return () => setMode('idle')
    },
  },
  {
    name: 'Reasoning — Slow Trickle',
    description: 'Model is deep in thought. Sparse reasoning tokens every ~500ms.',
    run: ({ setMode, inject }) => {
      setMode('reasoning')
      const id = setInterval(() => inject(8 + Math.random() * 12), 500)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Steady Stream',
    description: 'Model reasoning at a steady clip. ~30-60 chars every 100ms.',
    run: ({ setMode, inject }) => {
      setMode('reasoning')
      const id = setInterval(() => inject(30 + Math.random() * 30), 100)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Reasoning — Burst Pattern',
    description: '"do-do-do-DA" — small trickles punctuated by big reasoning bursts.',
    run: ({ setMode, inject }) => {
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
    run: ({ setMode, inject }) => {
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
    run: ({ setMode }) => {
      setMode('building')
      return () => setMode('idle')
    },
  },
  {
    name: 'Building — Module Completions',
    description: 'Sweep + large bursts every ~2s (simulating module/form done events).',
    run: ({ setMode, inject }) => {
      setMode('building')
      const id = setInterval(() => inject(200), 2000)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Building — Rapid Forms',
    description: 'Forms completing in quick succession — frequent medium bursts.',
    run: ({ setMode, inject }) => {
      setMode('building')
      const id = setInterval(() => inject(100 + Math.random() * 100), 600)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Editing — Full Width',
    description: 'Agent editing with no specific target. Defrag across entire grid.',
    run: ({ setMode, injectThink, setFocus }) => {
      setMode('editing')
      setFocus(null)
      const id = setInterval(() => injectThink(20 + Math.random() * 40), 120)
      return () => { clearInterval(id); setFocus(null); setMode('idle') }
    },
  },
  {
    name: 'Editing — Form Focus (30-60%)',
    description: 'Agent editing a specific form. Defrag concentrated in middle zone.',
    run: ({ setMode, injectThink, setFocus }) => {
      setMode('editing')
      setFocus({ start: 0.30, end: 0.60 })
      const id = setInterval(() => injectThink(25 + Math.random() * 35), 100)
      return () => { clearInterval(id); setFocus(null); setMode('idle') }
    },
  },
  {
    name: 'Editing — Question Focus (narrow)',
    description: 'Agent editing a single question. Tight defrag zone at ~20%.',
    run: ({ setMode, injectThink, setFocus }) => {
      setMode('editing')
      setFocus({ start: 0.12, end: 0.28 })
      const id = setInterval(() => injectThink(30 + Math.random() * 50), 100)
      return () => { clearInterval(id); setFocus(null); setMode('idle') }
    },
  },
  {
    name: 'Editing — Focus Transition',
    description: 'Agent moves between zones: starts at left, jumps to right, then center.',
    run: ({ setMode, injectThink, setFocus }) => {
      setMode('editing')
      setFocus({ start: 0.0, end: 0.25 })
      const timers: ReturnType<typeof setTimeout>[] = []
      const id = setInterval(() => injectThink(20 + Math.random() * 40), 100)

      timers.push(setTimeout(() => setFocus({ start: 0.70, end: 0.95 }), 3000))
      timers.push(setTimeout(() => setFocus({ start: 0.35, end: 0.65 }), 6000))
      timers.push(setTimeout(() => setFocus({ start: 0.0, end: 0.25 }), 9000))

      return () => {
        clearInterval(id)
        timers.forEach(clearTimeout)
        setFocus(null)
        setMode('idle')
      }
    },
  },
  {
    name: 'Editing — With Delivery Bursts',
    description: 'Agent making edits that trigger data parts. Defrag + burst flashes.',
    run: ({ setMode, inject, injectThink, setFocus }) => {
      setMode('editing')
      setFocus({ start: 0.20, end: 0.55 })
      const thinkId = setInterval(() => injectThink(25 + Math.random() * 30), 120)
      const burstId = setInterval(() => inject(100 + Math.random() * 100), 2000)
      return () => {
        clearInterval(thinkId)
        clearInterval(burstId)
        setFocus(null)
        setMode('idle')
      }
    },
  },
  {
    name: 'Full Lifecycle',
    description: 'Sending → Reasoning → Building → Done. Complete generation flow.',
    run: ({ setMode, inject }) => {
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
    name: 'Build → Edit Lifecycle',
    description: 'Building completes, then agent starts editing a specific form.',
    run: ({ setMode, inject, injectThink, setFocus }) => {
      setMode('building')
      const timers: ReturnType<typeof setTimeout>[] = []
      const intervals: ReturnType<typeof setInterval>[] = []

      // Building with energy
      const buildId = setInterval(() => inject(80 + Math.random() * 60), 200)
      intervals.push(buildId)

      // At 4s: transition to editing
      timers.push(setTimeout(() => {
        clearInterval(buildId)
        setMode('editing')
        setFocus({ start: 0.25, end: 0.55 })
        const editId = setInterval(() => injectThink(25 + Math.random() * 35), 100)
        intervals.push(editId)

        // At 7s: burst from completed edit
        timers.push(setTimeout(() => inject(150), 3000))

        // At 9s: move focus to another zone
        timers.push(setTimeout(() => setFocus({ start: 0.60, end: 0.85 }), 5000))

        // At 12s: done
        timers.push(setTimeout(() => {
          clearInterval(editId)
          setFocus(null)
          setMode('idle')
        }, 8000))
      }, 4000))

      return () => {
        intervals.forEach(clearInterval)
        timers.forEach(clearTimeout)
        setFocus(null)
        setMode('idle')
      }
    },
  },
  {
    name: 'Mode Transitions',
    description: 'Rapidly cycles through modes every 2s to test blending.',
    run: ({ setMode, inject, setFocus }) => {
      const modes: SignalMode[] = ['sending', 'reasoning', 'building', 'editing', 'idle']
      let idx = 0
      setMode(modes[0])
      const id = setInterval(() => {
        idx = (idx + 1) % modes.length
        setMode(modes[idx])
        if (modes[idx] === 'reasoning') inject(60)
        if (modes[idx] === 'building') inject(150)
        if (modes[idx] === 'editing') setFocus({ start: 0.3, end: 0.7 })
        if (modes[idx] !== 'editing') setFocus(null)
      }, 2000)
      return () => { clearInterval(id); setFocus(null); setMode('idle') }
    },
  },
  {
    name: 'Error Recovering — With Think Energy',
    description: 'SA hit an issue but is still working. Reasoning with ~35% warm-hued cells.',
    run: ({ setMode, inject }) => {
      setMode('error-recovering')
      const id = setInterval(() => inject(20 + Math.random() * 40), 120)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Error Recovering — Sparse',
    description: 'Recovering with minimal energy. Slow amber-rose flickers in ambient.',
    run: ({ setMode, inject }) => {
      setMode('error-recovering')
      const id = setInterval(() => inject(3 + Math.random() * 5), 500)
      return () => { clearInterval(id); setMode('idle') }
    },
  },
  {
    name: 'Error Fatal',
    description: 'Unrecoverable error. Erratic warm flicker → slow fade → dim rose embers.',
    run: ({ setMode }) => {
      setMode('error-fatal')
      return () => setMode('idle')
    },
  },
  {
    name: 'Building → Error Recovering → Fatal',
    description: 'Full error lifecycle: building normally, hits an issue, tries to recover, gives up.',
    run: ({ setMode, inject }) => {
      setMode('building')
      const timers: ReturnType<typeof setTimeout>[] = []
      const intervals: ReturnType<typeof setInterval>[] = []

      // Building with energy
      const buildId = setInterval(() => inject(80 + Math.random() * 60), 200)
      intervals.push(buildId)

      // At 3s: transition to recovering
      timers.push(setTimeout(() => {
        clearInterval(buildId)
        setMode('error-recovering')
        const recoverId = setInterval(() => inject(15 + Math.random() * 25), 150)
        intervals.push(recoverId)

        // At 6s: give up
        timers.push(setTimeout(() => {
          clearInterval(recoverId)
          setMode('error-fatal')
        }, 3000))
      }, 3000))

      return () => {
        intervals.forEach(clearInterval)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
]

export default function SignalTestPage() {
  const [activeScenario, setActiveScenario] = useState<number | null>(null)
  const [mode, setMode] = useState<SignalMode>('idle')
  const [width, setWidth] = useState(280)
  const controllerRef = useRef<SignalGridController | null>(null)
  const energyRef = useRef(0)
  const thinkEnergyRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ctrl = new SignalGridController({
      consumeEnergy: () => {
        const e = energyRef.current
        energyRef.current = 0
        return e
      },
      consumeThinkEnergy: () => {
        const e = thinkEnergyRef.current
        thinkEnergyRef.current = 0
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

  const injectThink = useCallback((amount: number) => {
    thinkEnergyRef.current += amount
  }, [])

  const setFocus = useCallback((focus: EditFocus | null) => {
    controllerRef.current?.setEditFocus(focus)
  }, [])

  const ctx: ScenarioContext = { setMode, inject, injectThink, setFocus }

  const runScenario = useCallback((index: number) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    setActiveScenario(index)
    energyRef.current = 0
    thinkEnergyRef.current = 0
    cleanupRef.current = scenarios[index].run(ctx)
  }, [ctx])

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
              <SignalPanel active={mode !== 'idle'} label={signalLabel(mode)} error={mode === 'error-recovering' || mode === 'error-fatal'}>
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
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-nova-text-muted font-mono">Burst:</span>
              {[5, 20, 50, 100, 200, 500].map(amount => (
                <button
                  key={`b-${amount}`}
                  onClick={() => inject(amount)}
                  className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-violet/40 hover:bg-nova-violet/5 transition-colors cursor-pointer font-mono"
                >
                  +{amount}
                </button>
              ))}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-nova-text-muted font-mono">Think:</span>
              {[5, 20, 50, 100, 200, 500].map(amount => (
                <button
                  key={`t-${amount}`}
                  onClick={() => injectThink(amount)}
                  className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-cyan/40 hover:bg-nova-cyan/5 transition-colors cursor-pointer font-mono"
                >
                  +{amount}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Mode buttons */}
        <div className="space-y-2">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Direct Mode Control
          </label>
          <div className="flex gap-2 flex-wrap">
            {(['sending', 'reasoning', 'building', 'editing', 'error-recovering', 'error-fatal', 'idle'] as SignalMode[]).map(m => (
              <button
                key={m}
                onClick={() => {
                  cleanupRef.current?.()
                  cleanupRef.current = null
                  setActiveScenario(null)
                  setMode(m)
                  if (m === 'editing') setFocus({ start: 0.3, end: 0.7 })
                  if (m !== 'editing') setFocus(null)
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

        {/* Edit focus control — only visible in editing mode */}
        {mode === 'editing' && (
          <div className="space-y-2">
            <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
              Edit Focus Zone
            </label>
            <div className="flex gap-2 flex-wrap">
              {([
                ['Full', null],
                ['Left', { start: 0, end: 0.3 }],
                ['Center', { start: 0.3, end: 0.7 }],
                ['Right', { start: 0.7, end: 1 }],
                ['Narrow', { start: 0.4, end: 0.55 }],
                ['Tight', { start: 0.15, end: 0.25 }],
              ] as [string, EditFocus | null][]).map(([label, f]) => (
                <button
                  key={label}
                  onClick={() => setFocus(f)}
                  className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-cyan/40 hover:bg-nova-cyan/5 transition-colors cursor-pointer font-mono"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

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
