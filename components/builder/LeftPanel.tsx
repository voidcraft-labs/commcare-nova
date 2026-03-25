'use client'
import { Icon } from '@iconify/react'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import type { UIMessage } from 'ai'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { ChatSidebar } from '@/components/chat/ChatSidebar'

interface LeftPanelProps {
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  onSend: (message: string) => void
  addToolOutput: (params: { tool: string; toolCallId: string; output: unknown }) => void
  readOnly?: boolean
  onClose: () => void
}

export function LeftPanel({
  messages,
  status,
  onSend,
  addToolOutput,
  readOnly,
  onClose,
}: LeftPanelProps) {
  return (
    <div className="w-80 border border-nova-border-bright border-l-0 bg-nova-deep flex flex-col shrink-0 h-full rounded-r-xl m-2 ml-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
        <span className="text-[13px] font-medium text-nova-text-secondary">Chat</span>
        <button
          onClick={onClose}
          className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
        >
          <Icon icon={ciChevronLeft} width="14" height="14" />
        </button>
      </div>

      {/* Chat content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <ErrorBoundary>
          <ChatSidebar
            mode="sidebar-embedded"
            messages={messages}
            status={status}
            onSend={onSend}
            addToolOutput={addToolOutput}
            readOnly={readOnly}
          />
        </ErrorBoundary>
      </div>
    </div>
  )
}
