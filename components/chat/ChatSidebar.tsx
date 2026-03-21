'use client'
import { useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { UIMessage } from 'ai'
import { Icon } from '@iconify/react'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase } from '@/lib/services/builder'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatInput } from '@/components/chat/ChatInput'
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator'

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

  // Route typed messages as question answers when a QuestionCard is waiting
  const handleSend = useCallback((text: string) => {
    if (pendingAnswerRef.current) {
      pendingAnswerRef.current(text)
    } else {
      onSend(text)
    }
  }, [onSend])

  // Auto-scroll to bottom when new messages are added.
  // MutationObserver watches for DOM child changes and scrolls on each mutation.
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const observer = new MutationObserver(() => {
      el.scrollTop = el.scrollHeight
    })
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

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
