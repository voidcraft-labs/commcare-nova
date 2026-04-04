'use client'
import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { UIMessage } from 'ai'
import { Icon } from '@iconify/react/offline'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import { useBuilder } from '@/hooks/useBuilder'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatInput } from '@/components/chat/ChatInput'
import { SignalGrid } from '@/components/chat/SignalGrid'
import { SignalPanel } from '@/components/chat/SignalPanel'
import { SignalGridController, defaultLabel, type SignalMode } from '@/lib/signalGridController'
import { type Builder, BuilderPhase, GenerationStage } from '@/lib/services/builder'

/** Sidebar panel width in pixels. Exported so siblings (e.g. cursor mode bar
 *  positioning in BuilderLayout) can derive offsets without magic numbers. */
export const CHAT_SIDEBAR_WIDTH = 280

/** Create a SignalGridController whose energy callbacks close over a ref (not
 *  a direct value) so they always read the latest builder instance. Safe across
 *  the gap between old controller teardown and new controller creation. */
function createGridController(builderRef: { current: Builder }): SignalGridController {
  return new SignalGridController({
    consumeEnergy: () => builderRef.current.drainEnergy(),
    consumeThinkEnergy: () => builderRef.current.drainThinkEnergy(),
    consumeScaffoldProgress: () => builderRef.current.scaffoldProgress,
  })
}

interface ChatSidebarProps {
  centered: boolean
  heroLogo?: ReactNode
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  onSend: (message: string) => void
  onClose?: () => void
  addToolOutput: (params: {
    tool: string
    toolCallId: string
    output: unknown
  }) => void
  readOnly?: boolean
}

export function ChatSidebar({
  centered,
  heroLogo,
  messages,
  status,
  onSend,
  onClose,
  addToolOutput,
  readOnly,
}: ChatSidebarProps) {
  const builder = useBuilder()
  const isLoading = status === 'submitted' || status === 'streaming'

  // ── Signal Grid — controller scoped to the builder instance ──────────
  // ChatSidebar is always-mounted (width animated to 0 when "closed"), so
  // refs persist across sidebar open/close. When the builder changes (new
  // project via BuilderProvider), we destroy the old controller's animation
  // loop and create a fresh one. Callbacks close over builderRef so they
  // always read the latest instance — safe across the teardown gap.
  const builderRef = useRef(builder)
  builderRef.current = builder
  const builderIdentityRef = useRef(builder)
  const gridControllerRef = useRef<SignalGridController | null>(null)
  if (builder !== builderIdentityRef.current || !gridControllerRef.current) {
    gridControllerRef.current?.destroy()
    builderIdentityRef.current = builder
    gridControllerRef.current = createGridController(builderRef)
  }
  const gridController = gridControllerRef.current

  // Destroy the controller's animation loop on unmount (page navigation away)
  useEffect(() => () => { gridControllerRef.current?.destroy() }, [])

  const [introMode, setIntroMode] = useState<'reasoning' | null>(null)
  // Initialize from the controller's live state so remounts don't flash
  // from 'SYS:IDLE' to the real label. On first mount the controller is
  // in 'idle' mode, which matches the default anyway.
  const [activeMode, setActiveMode] = useState<SignalMode>(() => gridController.currentMode)
  const [activeLabel, setActiveLabel] = useState(() => gridController.currentModeLabel)

  // Wire mode-applied callback to React state — ref indirection so the
  // callback closure doesn't go stale across renders.
  const activeStateRef = useRef({ setActiveMode, setActiveLabel })
  activeStateRef.current = { setActiveMode, setActiveLabel }

  useEffect(() => {
    gridController.setOnModeApplied((mode, label) => {
      activeStateRef.current.setActiveMode(mode)
      activeStateRef.current.setActiveLabel(label)
    })
    return () => gridController.setOnModeApplied(null)
  }, [gridController])

  // Desired mode + label from builder state — sent to controller, which queues if busy.
  // Gate reasoning/editing on `status === 'streaming'` so the send wave keeps looping
  // during the 'submitted' wait period (server hasn't started responding yet).
  const desiredMode = ((): SignalMode => {
    if (introMode) return introMode
    // Generation errors — phase stays Generating, error is metadata
    if (builder.generationError) {
      return builder.generationError.severity === 'recovering' ? 'error-recovering' : 'error-fatal'
    }
    // Early generation stages get the scaffolding visual (tetris board)
    if (builder.generationStage === GenerationStage.DataModel || builder.generationStage === GenerationStage.Structure) {
      return 'scaffolding'
    }
    // Later generation stages get the building visual (pink sweep + bursts)
    if (builder.isGenerating) return 'building'
    if (builder.agentActive) {
      // Keep the send wave looping until the server actually starts streaming.
      // During 'submitted', no tokens are flowing so reasoning/editing would
      // look dead — the whole point of the signal grid is to show activity.
      if (status === 'submitted') return 'sending'
      return builder.postBuildEdit ? 'editing' : 'reasoning'
    }
    // After a post-build edit: show 'done' if the SA actually mutated the blueprint
    // (addQuestion, editQuestion, etc.), 'idle' if it only asked questions.
    // completeGeneration() also clears postBuildEdit, so initial builds and validated
    // edits fall through to 'done' via the !postBuildEdit path.
    if (builder.phase === BuilderPhase.Ready) {
      return builder.postBuildEdit && !builder.editMadeMutations ? 'idle' : 'done'
    }
    return 'idle'
  })()

  const desiredLabel = builder.isGenerating && builder.statusMessage
    ? builder.statusMessage
    : defaultLabel(desiredMode)

  useEffect(() => {
    gridController.setMode(desiredMode, desiredLabel)
  }, [desiredMode, desiredLabel, gridController])

  // Elapsed timer — resets when the controller's active label or mode changes.
  // Label changes (e.g. "Building forms" → "Validating") reset the timer during
  // render via React's "derive state from props" pattern, so the interval continues
  // with the new base time. Mode changes are handled by the effect (start/stop).
  const [elapsed, setElapsed] = useState(0)
  const modeStartRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined)

  const prevLabelRef = useRef(activeLabel)
  if (prevLabelRef.current !== activeLabel) {
    prevLabelRef.current = activeLabel
    setElapsed(0)
    modeStartRef.current = Date.now()
  }

  useEffect(() => {
    clearInterval(timerRef.current)
    setElapsed(0)
    if (activeMode === 'idle' || activeMode === 'sending' || activeMode === 'done'
      || activeMode === 'error-recovering' || activeMode === 'error-fatal') return
    modeStartRef.current = Date.now()
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - modeStartRef.current) / 1000)
      setElapsed(secs)
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [activeMode])

  const gridSuffix = elapsed >= 30
    ? `(${elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`})`
    : undefined

  // Only enable layout animation during centered↔sidebar morph, not toolbar resizes
  const [morphing, setMorphing] = useState(false)
  const prevCenteredRef = useRef(centered)
  useEffect(() => {
    if (centered !== prevCenteredRef.current) {
      setMorphing(true)
      const id = setTimeout(() => setMorphing(false), 500)
      prevCenteredRef.current = centered
      return () => clearTimeout(id)
    }
  }, [centered])

  // Scroll state — persists across sidebar open/close because ChatSidebar
  // stays mounted (width animated to 0). No module-level variables needed.
  const chatScrollPinnedRef = useRef(true)
  const chatScrollTopRef = useRef(0)

  const pendingAnswerRef = useRef<((text: string) => void) | null>(null)
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(chatScrollPinnedRef.current)
  const isUserHoldingRef = useRef(false)

  const triggerSendWave = useCallback(() => {
    gridController.setMode('sending')
  }, [gridController])

  // Route typed messages as question answers when a QuestionCard is waiting
  const handleSend = useCallback((text: string) => {
    if (pendingAnswerRef.current) {
      pendingAnswerRef.current(text)
    } else {
      triggerSendWave()
      onSend(text)
    }
  }, [onSend, triggerSendWave])

  // Wrap addToolOutput to trigger send animation when a question block completes
  const handleToolOutput = useCallback((params: { tool: string; toolCallId: string; output: unknown }) => {
    if (params.tool === 'askQuestions') triggerSendWave()
    addToolOutput(params)
  }, [addToolOutput, triggerSendWave])

  // Smart scroll management: auto-scroll when near bottom, respect user scroll hold,
  // persist state across instances (tab switch, center → sidebar transition).
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el
    if (!el) return

    const THRESHOLD = 50
    let animFrameId: number | undefined

    const wasAtBottom = chatScrollPinnedRef.current
    isNearBottomRef.current = wasAtBottom

    if (wasAtBottom) {
      el.scrollTop = el.scrollHeight
      // Keep pinning during layout animation (center → sidebar, ~500ms)
      const startTime = performance.now()
      const pin = () => {
        if (performance.now() - startTime > 600) return
        if (isNearBottomRef.current && !isUserHoldingRef.current) {
          el.scrollTop = el.scrollHeight
        }
        animFrameId = requestAnimationFrame(pin)
      }
      animFrameId = requestAnimationFrame(pin)
    } else {
      el.scrollTop = chatScrollTopRef.current
    }

    const autoScroll = () => {
      if (isNearBottomRef.current && !isUserHoldingRef.current) {
        el.scrollTop = el.scrollHeight
      }
    }

    const checkNearBottom = () => {
      isNearBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD
    }

    const onScroll = () => {
      if (!isUserHoldingRef.current) checkNearBottom()
    }
    const onMouseDown = () => { isUserHoldingRef.current = true }
    const onMouseUp = () => {
      isUserHoldingRef.current = false
      checkNearBottom()
    }

    const mutationObserver = new MutationObserver(autoScroll)
    mutationObserver.observe(el, { childList: true, subtree: true })

    const resizeObserver = new ResizeObserver(autoScroll)
    resizeObserver.observe(el)

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onMouseUp)

    return () => {
      chatScrollPinnedRef.current = isNearBottomRef.current
      chatScrollTopRef.current = el.scrollTop
      if (animFrameId !== undefined) cancelAnimationFrame(animFrameId)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      scrollElRef.current = null
    }
  }, [])

  // Anchor scroll position during center↔sidebar morph.
  // The existing ResizeObserver + onScroll race: onScroll fires first when the
  // browser clamps scrollTop during resize, clearing isNearBottomRef before the
  // ResizeObserver can act. This rAF loop captures intent at morph start and
  // overrides on every frame, keeping position stable throughout the transition.
  useEffect(() => {
    const el = scrollElRef.current
    if (!morphing || !el) return

    const pinToBottom = isNearBottomRef.current
    const savedTop = el.scrollTop
    let id: number

    const tick = () => {
      if (!isUserHoldingRef.current) {
        el.scrollTop = pinToBottom ? el.scrollHeight : savedTop
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(id)
  }, [morphing])

  // ── Auto-scroll question cards into view when they appear ──
  let activeQuestionCount = 0
  for (const msg of messages) {
    for (const part of msg.parts as any[]) {
      if (part.type === 'tool-askQuestions' && part.state === 'input-available') {
        activeQuestionCount++
      }
    }
  }

  const prevActiveQCountRef = useRef(0)
  useEffect(() => {
    if (activeQuestionCount > prevActiveQCountRef.current && scrollElRef.current && !isUserHoldingRef.current) {
      requestAnimationFrame(() => {
        const el = scrollElRef.current
        if (!el) return
        const cards = el.querySelectorAll('[data-question-card="waiting"]')
        const lastCard = cards[cards.length - 1] as HTMLElement | undefined
        if (lastCard) {
          lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      })
    }
    prevActiveQCountRef.current = activeQuestionCount
  }, [activeQuestionCount])

  return (
    <motion.div
      initial={centered ? false : { x: CHAT_SIDEBAR_WIDTH, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={centered ? { opacity: 0 } : { x: CHAT_SIDEBAR_WIDTH, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className={centered
        ? 'absolute inset-0 z-raised flex flex-col items-center justify-center gap-6 pointer-events-none'
        : 'shrink-0 h-full'
      }
    >
      {centered && heroLogo}
      <motion.div
        layout={morphing ? 'position' : false}
        className={`pointer-events-auto flex flex-col overflow-hidden transition-[width,max-width,max-height,height,border-radius,border-color] duration-[450ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${centered
          ? 'w-full max-w-2xl max-h-[min(700px,80vh)] rounded-2xl border border-nova-border bg-nova-deep'
          : `w-[${CHAT_SIDEBAR_WIDTH}px] h-full border-l border-nova-border-bright bg-nova-deep`
        }`}
        transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
      >
        {/* Sidebar header */}
        {!centered && (
          <div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
            <span className="text-[13px] font-medium text-nova-text-secondary">Chat</span>
            <button
              type="button"
              onClick={onClose}
              className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
            >
              <Icon icon={ciChevronRight} width="14" height="14" />
            </button>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className={`${centered ? '' : 'flex-1'} overflow-y-auto p-4 space-y-4`}>
          {messages.length === 0 && !isLoading && (
            <div className={centered ? 'text-center' : 'text-center py-8'}>
              {centered ? (
                <WelcomeIntro builder={builder} setIntroMode={setIntroMode} />
              ) : (
                <p className="text-sm text-nova-text-muted">
                  Describe the CommCare app you want to build.
                </p>
              )}
            </div>
          )}
          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              addToolOutput={handleToolOutput}
              pendingAnswerRef={pendingAnswerRef}
            />
          ))}
        </div>

        {/* Nova's thinking panel — permanent status display */}
        <div className="shrink-0">
          <SignalPanel
              active={activeMode !== 'idle'}
              label={activeLabel}
              suffix={gridSuffix}
              error={activeMode === 'error-fatal'}
              recovering={activeMode === 'error-recovering'}
              done={activeMode === 'done'}
            >
              <SignalGrid controller={gridController} messages={messages} />
            </SignalPanel>
        </div>

        {/* Input — hidden in readOnly mode */}
        {!readOnly && (
          <div className="shrink-0">
            <ChatInput
              onSend={handleSend}
              disabled={isLoading || builder.isGenerating}
              centered={centered}
            />
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

/** Staggered welcome text with a coordinated burst on the signal grid. */
function WelcomeIntro({ builder, setIntroMode }: {
  builder: ReturnType<typeof useBuilder>
  setIntroMode: (mode: 'reasoning' | null) => void
}) {
  const [stage, setStage] = useState(0) // 0: nothing, 1: heading, 2: subtitle

  useEffect(() => {
    // Activate reasoning mode for the intro bursts
    setIntroMode('reasoning')
    builder.injectEnergy(40)

    const t1 = setTimeout(() => {
      setStage(1)
      builder.injectEnergy(40)
    }, 1200)

    const t2 = setTimeout(() => {
      setStage(2)
      builder.injectEnergy(80)
    }, 1700)

    // Let the grid settle, then back to idle
    const t3 = setTimeout(() => {
      setIntroMode(null)
    }, 2400)

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [builder, setIntroMode])

  return (
    <>
      <motion.h1
        initial={{ opacity: 0, y: 6 }}
        animate={stage >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="text-xl font-display font-medium text-nova-text mb-1.5"
      >
        What do you want to build?
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={stage >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="text-nova-text-secondary text-sm leading-relaxed"
      >
        Describe your CommCare app — workflows, data collection, and who will use it.
      </motion.p>
    </>
  )
}
