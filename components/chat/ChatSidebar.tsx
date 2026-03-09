'use client'
import { useState, useRef, useEffect } from 'react'
import { motion } from 'motion/react'
import type { ConversationMessage } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatInput } from '@/components/chat/ChatInput'

interface ChatSidebarProps {
  messages: ConversationMessage[]
  isStreaming: boolean
  onSend: (message: string) => void
  onClose: () => void
  onGenerate: (appName: string) => void
  hasBlueprint: boolean
  isGenerating: boolean
}

export function ChatSidebar({ messages, isStreaming, onSend, onClose, onGenerate, hasBlueprint, isGenerating }: ChatSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showBuildButton, setShowBuildButton] = useState(false)

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Show build button after assistant responds with an app-spec
  useEffect(() => {
    if (messages.length >= 2 && !hasBlueprint && !isGenerating) {
      const lastAssistant = messages.filter(m => m.role === 'assistant').pop()
      if (lastAssistant && (lastAssistant.content.includes('<app-spec>') || lastAssistant.content.length > 200)) {
        setShowBuildButton(true)
      }
    }
  }, [messages, hasBlueprint, isGenerating])

  const handleBuild = () => {
    // Extract app name from conversation or use default
    const firstUserMsg = messages.find(m => m.role === 'user')?.content || ''
    let appName = 'CommCare App'
    // Try to extract a reasonable name from the first message
    const cleanedDesc = firstUserMsg.replace(
      /^(I need|I want|Create|Build|Make|Generate|Design|Develop|Help me build|Help me create|Can you build|Can you create|Please create|Please build)\s+(a|an|the|me a|me an)?\s*/i,
      ''
    )
    const words = cleanedDesc.split(/\s+/).slice(0, 5).join(' ')
    if (words.length > 3) {
      appName = words.replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'CommCare App'
    }

    onGenerate(appName)
    setShowBuildButton(false)
  }

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
        {messages.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-nova-text-muted">
              Describe the CommCare app you want to build.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}

        {/* Build button */}
        {showBuildButton && !isGenerating && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex justify-center pt-2"
          >
            <Button onClick={handleBuild} size="md" className="w-full">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              Build This App
            </Button>
          </motion.div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0">
        <ChatInput onSend={onSend} disabled={isStreaming} />
      </div>
    </motion.div>
  )
}
