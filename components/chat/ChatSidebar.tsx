'use client'
import { useRef, useEffect } from 'react'
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
  mode: 'centered' | 'sidebar'
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const isCentered = mode === 'centered'

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <motion.div
      layout
      layoutId="chat-panel"
      className={
        isCentered
          ? 'w-full max-w-2xl max-h-[min(700px,80vh)] flex flex-col rounded-2xl border border-nova-border bg-nova-deep overflow-hidden'
          : 'w-[380px] border-r border-nova-border bg-nova-deep flex flex-col shrink-0 h-full'
      }
      transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
    >
      {/* Header — sidebar only */}
      {!isCentered && (
        <div className="px-4 py-3 border-b border-nova-border flex items-center justify-between shrink-0">
          <h2 className="text-sm font-medium text-nova-text-secondary">Chat</h2>
          {onClose && (
            <button
              onClick={onClose}
              className="text-nova-text-muted hover:text-nova-text transition-colors p-1"
            >
              <Icon icon={ciChevronLeft} width="14" height="14" />
            </button>
          )}
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
            onSend={onSend}
            disabled={isLoading || [BuilderPhase.Planning, BuilderPhase.Designing, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validating, BuilderPhase.Fixing, BuilderPhase.Editing].includes(builder.phase)}
            centered={isCentered}
          />
        </div>
      )}
    </motion.div>
  )
}
