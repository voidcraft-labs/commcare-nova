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
  onClose: () => void
  addToolOutput: (params: {
    tool: string
    toolCallId: string
    output: unknown
  }) => void
}

export function ChatSidebar({
  messages,
  status,
  onSend,
  onClose,
  addToolOutput,
}: ChatSidebarProps) {
  const builder = useBuilder()
  const isLoading = status === 'submitted' || status === 'streaming'

  const showThinking = isLoading && builder.phase === BuilderPhase.Idle
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <motion.div
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="w-[380px] border-r border-nova-border bg-nova-deep flex flex-col shrink-0"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-nova-border flex items-center justify-between shrink-0">
        <h2 className="text-sm font-medium text-nova-text-secondary">Chat</h2>
        <button
          onClick={onClose}
          className="text-nova-text-muted hover:text-nova-text transition-colors p-1"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10 2L4 7l6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Messages */}
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
          />
        ))}
        <AnimatePresence>
          {showThinking && <ThinkingIndicator />}
        </AnimatePresence>
      </div>

      {/* Input */}
      <div className="shrink-0">
        <ChatInput onSend={onSend} disabled={isLoading} />
      </div>
    </motion.div>
  )
}
