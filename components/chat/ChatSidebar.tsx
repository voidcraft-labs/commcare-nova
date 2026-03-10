'use client'
import { useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { UIMessage } from 'ai'
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
}

export function ChatSidebar({
  messages,
  status,
  onSend,
  onClose,
  addToolOutput,
  mode,
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
          ? 'w-full max-w-2xl max-h-[min(700px,80vh)] flex flex-col'
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M10 2L4 7l6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isLoading && (
          <div className={isCentered ? 'text-center py-12' : 'text-center py-8'}>
            {isCentered ? (
              <>
                <h1 className="text-2xl font-display font-semibold text-nova-text mb-2">
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

      {/* Input */}
      <div className="shrink-0">
        <ChatInput
          onSend={onSend}
          disabled={isLoading || builder.phase === BuilderPhase.Planning || builder.phase === BuilderPhase.Scaffolding}
          centered={isCentered}
        />
      </div>
    </motion.div>
  )
}
