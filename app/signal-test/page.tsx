'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { SignalGridController, type SignalMode, type EditFocus } from '@/lib/signalGridController'
import { SignalPanel } from '@/components/chat/SignalPanel'
import { defaultLabel } from '@/lib/signalGridController'
import { PIECES } from '@/lib/tetrisProgressSolver'

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
  setScaffoldProgress: (p: number) => void
  /** One-shot callback for when the current animation settles (wave cycle done, fill complete). */
  onSettled: (cb: () => void) => void
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
    description: 'Sending → Reasoning → Scaffolding → Building → Done. All transitions driven by onSettled.',
    run: ({ setMode, inject, injectThink, setScaffoldProgress, onSettled }) => {
      setMode('sending')
      const timers: ReturnType<typeof setTimeout>[] = []
      const intervals: ReturnType<typeof setInterval>[] = []

      // Sending settles after one wave → reasoning
      setMode('reasoning') // queued — waits for wave cycle
      const reasoningId = setInterval(() => injectThink(10 + Math.random() * 40), 150)
      intervals.push(reasoningId)

      // After 3s of reasoning → scaffolding
      onSettled(() => {
        timers.push(setTimeout(() => {
          clearInterval(reasoningId)
          setMode('scaffolding')
          const thinkId = setInterval(() => injectThink(15 + Math.random() * 25), 150)
          intervals.push(thinkId)

          setScaffoldProgress(0.30)
          timers.push(setTimeout(() => setScaffoldProgress(0.55), 1500))
          timers.push(setTimeout(() => setScaffoldProgress(0.85), 3000))

          // At 4.5s: request building (queued until scaffold fill completes)
          timers.push(setTimeout(() => {
            setScaffoldProgress(1.0)
            clearInterval(thinkId)
            setMode('building') // queued
            const buildId = setInterval(() => inject(80 + Math.random() * 60), 200)
            intervals.push(buildId)

            // When scaffold settles → building active, run for 4s then done
            onSettled(() => {
              timers.push(setTimeout(() => inject(200), 1500))
              timers.push(setTimeout(() => inject(200), 3000))
              timers.push(setTimeout(() => {
                intervals.forEach(clearInterval)
                setMode('done')
              }, 4000))
            })
          }, 4500))
        }, 3000))
      })

      return () => {
        intervals.forEach(clearInterval)
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
    name: 'Scaffolding — Steady Progress',
    description: 'Tetris fill with real milestone timing: schema → partial → scaffold → done.',
    run: ({ setMode, setScaffoldProgress, injectThink }) => {
      setMode('scaffolding')
      setScaffoldProgress(0.15)
      const timers: ReturnType<typeof setTimeout>[] = []
      const thinkId = setInterval(() => injectThink(15 + Math.random() * 25), 150)

      timers.push(setTimeout(() => setScaffoldProgress(0.30), 2000))
      timers.push(setTimeout(() => setScaffoldProgress(0.55), 4500))
      timers.push(setTimeout(() => setScaffoldProgress(0.85), 7000))
      timers.push(setTimeout(() => setScaffoldProgress(1.0), 10000))

      return () => {
        clearInterval(thinkId)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Scaffolding — Fast Complete',
    description: 'Schema at 30%, then jump straight to 100% after 1.5s. Tests rapid catch-up.',
    run: ({ setMode, setScaffoldProgress, injectThink }) => {
      setMode('scaffolding')
      setScaffoldProgress(0.30)
      const timers: ReturnType<typeof setTimeout>[] = []
      const thinkId = setInterval(() => injectThink(20 + Math.random() * 30), 120)

      timers.push(setTimeout(() => setScaffoldProgress(1.0), 1500))

      return () => {
        clearInterval(thinkId)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Scaffolding — Stall at Cap',
    description: 'Progress reaches 60% then stalls for 8s (breathing front), then completes.',
    run: ({ setMode, setScaffoldProgress, injectThink }) => {
      setMode('scaffolding')
      setScaffoldProgress(0.60)
      const timers: ReturnType<typeof setTimeout>[] = []
      const thinkId = setInterval(() => injectThink(10 + Math.random() * 15), 200)

      timers.push(setTimeout(() => setScaffoldProgress(1.0), 8000))

      return () => {
        clearInterval(thinkId)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Scaffolding → Building → Done',
    description: 'Full lifecycle: scaffold fills, transitions to building, then done. All driven by onSettled.',
    run: ({ setMode, setScaffoldProgress, inject, injectThink, onSettled }) => {
      setMode('scaffolding')
      setScaffoldProgress(0.15)
      const timers: ReturnType<typeof setTimeout>[] = []
      const intervals: ReturnType<typeof setInterval>[] = []
      const thinkId = setInterval(() => injectThink(20 + Math.random() * 30), 120)
      intervals.push(thinkId)

      timers.push(setTimeout(() => setScaffoldProgress(0.30), 1000))
      timers.push(setTimeout(() => setScaffoldProgress(0.55), 2500))
      timers.push(setTimeout(() => setScaffoldProgress(0.85), 4000))

      // At 5.5s: request completion → building is queued, starts when fill finishes
      timers.push(setTimeout(() => {
        setScaffoldProgress(1.0)
        setMode('building') // queued — controller resolves when scaffold fill completes

        // Start injecting building energy now (consumed when building mode activates)
        const buildId = setInterval(() => inject(80 + Math.random() * 60), 200)
        intervals.push(buildId)

        // When scaffolding settles (fill done, building starts), run building for 4s then done
        onSettled(() => {
          timers.push(setTimeout(() => inject(200), 1000))
          timers.push(setTimeout(() => inject(200), 2500))
          timers.push(setTimeout(() => {
            intervals.forEach(clearInterval)
            setMode('done')
          }, 4000))
        })
      }, 5500))

      return () => {
        intervals.forEach(clearInterval)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Build → Done',
    description: 'Building with energy bursts, then "du-du-DONEE" celebration transition.',
    run: ({ setMode, inject }) => {
      setMode('building')
      const timers: ReturnType<typeof setTimeout>[] = []
      const buildId = setInterval(() => inject(80 + Math.random() * 60), 200)

      timers.push(setTimeout(() => inject(200), 1000))
      timers.push(setTimeout(() => inject(200), 3000))

      timers.push(setTimeout(() => {
        clearInterval(buildId)
        setMode('done')
      }, 4000))

      return () => {
        clearInterval(buildId)
        timers.forEach(clearTimeout)
        setMode('idle')
      }
    },
  },
  {
    name: 'Mode Transitions',
    description: 'Rapidly cycles through modes every 2s to test blending.',
    run: ({ setMode, inject, setFocus }) => {
      const modes: SignalMode[] = ['sending', 'reasoning', 'scaffolding', 'building', 'editing', 'done', 'idle']
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
  const scaffoldProgressRef = useRef(0)
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
      consumeScaffoldProgress: () => scaffoldProgressRef.current,
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

  const setScaffoldProgress = useCallback((p: number) => {
    scaffoldProgressRef.current = Math.max(scaffoldProgressRef.current, p)
    controllerRef.current?.setScaffoldProgress(p)
  }, [])

  const onSettled = useCallback((cb: () => void) => {
    controllerRef.current?.onSettled(cb)
  }, [])

  const ctx: ScenarioContext = { setMode, inject, injectThink, setFocus, setScaffoldProgress, onSettled }

  const runScenario = useCallback((index: number) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    setActiveScenario(index)
    energyRef.current = 0
    thinkEnergyRef.current = 0
    scaffoldProgressRef.current = 0
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

        {/* Piece gallery — all pieces × all rotations on a 3-row mini grid */}
        <div className="space-y-2">
          <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
            Piece Catalogue
          </label>
          <div className="flex gap-6 flex-wrap">
            {PIECES.map(piece => (
              <div key={piece.id} className="space-y-1.5">
                <span className="text-xs text-nova-text-secondary font-mono">{piece.name}</span>
                <div className="flex gap-3">
                  {piece.rotations.map((shape, ri) => {
                    const maxR = Math.max(...shape.map(([r]) => r))
                    const maxC = Math.max(...shape.map(([, c]) => c))
                    const cells = new Set(shape.map(([r, c]) => `${r},${c}`))
                    return (
                      <div key={ri} className="flex flex-col items-center gap-1">
                        <div
                          className="grid gap-[2px]"
                          style={{
                            gridTemplateColumns: `repeat(${maxC + 1}, 8px)`,
                            gridTemplateRows: `repeat(${maxR + 1}, 8px)`,
                          }}
                        >
                          {Array.from({ length: (maxR + 1) * (maxC + 1) }, (_, i) => {
                            const r = Math.floor(i / (maxC + 1))
                            const c = i % (maxC + 1)
                            const on = cells.has(`${r},${c}`)
                            return (
                              <div
                                key={i}
                                className={`rounded-[1.5px] ${on ? 'bg-nova-cyan' : 'bg-nova-void/50'}`}
                                style={{ width: 8, height: 8, opacity: on ? 1 : 0.15 }}
                              />
                            )
                          })}
                        </div>
                        <span className="text-[9px] text-nova-text-muted font-mono">r{ri}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
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
              <SignalPanel active={mode !== 'idle'} label={defaultLabel(mode)} error={mode === 'error-fatal'} recovering={mode === 'error-recovering'} done={mode === 'done'}>
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
            {(['sending', 'reasoning', 'scaffolding', 'building', 'editing', 'error-recovering', 'error-fatal', 'done', 'idle'] as SignalMode[]).map(m => (
              <button
                key={m}
                onClick={() => {
                  cleanupRef.current?.()
                  cleanupRef.current = null
                  setActiveScenario(null)
                  scaffoldProgressRef.current = 0
                  setMode(m)
                  if (m === 'scaffolding') setScaffoldProgress(0.50)
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

        {/* Scaffold progress control — only visible in scaffolding mode */}
        {mode === 'scaffolding' && (
          <div className="space-y-2">
            <label className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
              Scaffold Progress
            </label>
            <div className="flex gap-2 flex-wrap">
              {([
                ['5%', 0.05], ['30%', 0.30], ['55%', 0.55],
                ['85%', 0.85], ['100%', 1.0],
              ] as [string, number][]).map(([label, p]) => (
                <button
                  key={label}
                  onClick={() => setScaffoldProgress(p)}
                  className="text-xs px-3 py-1.5 rounded border border-nova-border text-nova-text-secondary hover:border-nova-emerald/40 hover:bg-nova-emerald/5 transition-colors cursor-pointer font-mono"
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
