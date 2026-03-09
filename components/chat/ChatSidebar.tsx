'use client'
import { useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { ConversationMessage } from '@/lib/types'
import type { ActiveQuestionState } from '@/hooks/useChat'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatInput } from '@/components/chat/ChatInput'
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator'

interface ChatSidebarProps {
  messages: ConversationMessage[]
  isLoading: boolean
  isThinking: boolean
  isGenerating: boolean
  activeQuestions: ActiveQuestionState | null
  onSend: (message: string) => void
  onClose: () => void
  onSelectOption: (questionText: string, optionLabel: string) => void
  onGenerate: () => void
  onCancelGeneration: () => void
}

export function ChatSidebar({
  messages,
  isLoading,
  isThinking,
  isGenerating,
  activeQuestions,
  onSend,
  onClose,
  onSelectOption,
  onGenerate,
  onCancelGeneration,
}: ChatSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages or thinking state change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, activeQuestions?.currentIndex, isThinking])

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
        {messages.length === 0 && !isThinking && (
          <div className="text-center py-8">
            <p className="text-sm text-nova-text-muted">
              Describe the CommCare app you want to build.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage
            key={i}
            message={msg}
            activeQuestions={activeQuestions}
            isGenerating={isGenerating}
            onSelectOption={onSelectOption}
            onGenerate={onGenerate}
            onCancelGeneration={onCancelGeneration}
          />
        ))}
        <AnimatePresence>
          {isThinking && <ThinkingIndicator />}
        </AnimatePresence>
      </div>

      {/* Input */}
      <div className="shrink-0">
        <ChatInput onSend={onSend} disabled={isLoading && !activeQuestions} />
      </div>
    </motion.div>
  )
}
