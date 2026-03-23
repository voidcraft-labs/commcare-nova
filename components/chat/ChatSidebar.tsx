'use client'
import { useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { UIMessage } from 'ai'
import { Icon } from '@iconify/react'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase } from '@/lib/services/builder'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatInput } from '@/components/chat/ChatInput'
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator'

// ── Module-level scroll state persisted across ChatSidebar instances ──
let chatScrollPinned = true
let chatScrollTop = 0

interface ChatSidebarProps {
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  onSend: (message: string) => void
  onClose?: () => void
  addToolOutput: (params: {
    tool: string
    toolCallId: string
    output: unknown
  }) => void
  /** 'centered' = hero chat, 'sidebar' = standalone left panel, 'sidebar-embedded' = embedded in LeftPanel (no header/chrome) */
  mode: 'centered' | 'sidebar' | 'sidebar-embedded'
  readOnly?: boolean
}

export function ChatSidebar({
  messages,
  status,
  onSend,
  onClose,
  addToolOutput,
  mode,
  readOnly,
}: ChatSidebarProps) {
  const builder = useBuilder()
  const isLoading = status === 'submitted' || status === 'streaming'

  const showThinking = isLoading && builder.phase === BuilderPhase.Idle
  const pendingAnswerRef = useRef<((text: string) => void) | null>(null)
  const isCentered = mode === 'centered'
  const isEmbedded = mode === 'sidebar-embedded'
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(chatScrollPinned)
  const isUserHoldingRef = useRef(false)

  // Route typed messages as question answers when a QuestionCard is waiting
  const handleSend = useCallback((text: string) => {
    if (pendingAnswerRef.current) {
      pendingAnswerRef.current(text)
    } else {
      onSend(text)
    }
  }, [onSend])

  // Smart scroll management: auto-scroll when near bottom, respect user scroll hold,
  // persist state across instances (tab switch, center → sidebar transition).
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el
    if (!el) return

    const THRESHOLD = 50
    let animFrameId: number | undefined

    const wasAtBottom = chatScrollPinned
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
      el.scrollTop = chatScrollTop
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
      chatScrollPinned = isNearBottomRef.current
      chatScrollTop = el.scrollTop
      if (animFrameId !== undefined) cancelAnimationFrame(animFrameId)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      scrollElRef.current = null
    }
  }, [])

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

  // Embedded mode — just messages + input, no chrome. Parent (LeftPanel) provides the shell.
  if (isEmbedded) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && !isLoading && (
            <div className="text-center py-8">
              <p className="text-sm text-nova-text-muted">
                Describe the CommCare app you want to build.
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              addToolOutput={addToolOutput}
              pendingAnswerRef={pendingAnswerRef}
            />
          ))}
          <AnimatePresence>
            {showThinking && <ThinkingIndicator />}
          </AnimatePresence>
        </div>
        {!readOnly && (
          <div className="shrink-0">
            <ChatInput
              onSend={handleSend}
              disabled={isLoading || [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix].includes(builder.phase)}
              centered={false}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <motion.div
      layout={isCentered ? true : undefined}
      layoutId={isCentered ? 'chat-panel' : undefined}
      className={
        isCentered
          ? 'w-full max-w-2xl max-h-[min(700px,80vh)] flex flex-col rounded-2xl border border-nova-border bg-nova-deep overflow-hidden'
          : 'w-80 border border-nova-border-bright border-l-0 bg-nova-deep flex flex-col shrink-0 h-full rounded-r-xl m-2 ml-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]'
      }
      transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
    >
      {/* Header — standalone sidebar only */}
      {!isCentered && (
        <div className="px-4 h-12 border-b border-nova-border flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="text-nova-text-muted hover:text-nova-text transition-colors p-1 cursor-pointer"
          >
            <Icon icon={ciChevronLeft} width="14" height="14" />
          </button>
          <h2 className="text-sm font-medium text-nova-text-secondary">Chat</h2>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className={`${isCentered ? '' : 'flex-1'} overflow-y-auto p-4 space-y-4`}>
        {messages.length === 0 && !isLoading && (
          <div className={isCentered ? 'text-center' : 'text-center py-8'}>
            {isCentered ? (
              <>
                <h1 className="text-xl font-display font-medium text-nova-text mb-1.5">
                  What do you want to build?
                </h1>
                <p className="text-nova-text-secondary text-sm leading-relaxed">
                  Describe your CommCare app — workflows, data collection, and who will use it.
                </p>
              </>
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
            addToolOutput={addToolOutput}
            pendingAnswerRef={pendingAnswerRef}
          />
        ))}
        <AnimatePresence>
          {showThinking && <ThinkingIndicator />}
        </AnimatePresence>
      </div>

      {/* Input — hidden in readOnly mode */}
      {!readOnly && (
        <div className="shrink-0">
          <ChatInput
            onSend={handleSend}
            disabled={isLoading || [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix].includes(builder.phase)}
            centered={isCentered}
          />
        </div>
      )}
    </motion.div>
  )
}
