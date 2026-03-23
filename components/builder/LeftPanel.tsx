'use client'
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import ciMessage from '@iconify-icons/ci/message'
import tablerListTree from '@iconify-icons/tabler/list-tree'
import type { UIMessage } from 'ai'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { AppTree } from '@/components/builder/AppTree'
import { BuilderPhase, type TreeData } from '@/lib/services/builder'
import type { Builder } from '@/lib/services/builder'

export type LeftTab = 'chat' | 'structure'

interface LeftPanelProps {
  builder: Builder
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  onSend: (message: string) => void
  addToolOutput: (params: { tool: string; toolCallId: string; output: unknown }) => void
  readOnly?: boolean
  onClose: () => void
  /** Which tab is currently active — controlled by parent for generation flow */
  activeTab: LeftTab
  onTabChange: (tab: LeftTab) => void
  /** Called when a tree item is selected — parent handles both builder.select() and nav sync */
  onTreeSelect: (selection: any) => void
}

export function LeftPanel({
  builder,
  messages,
  status,
  onSend,
  addToolOutput,
  readOnly,
  onClose,
  activeTab,
  onTabChange,
  onTreeSelect,
}: LeftPanelProps) {
  return (
    <div className="w-80 border border-nova-border-bright border-l-0 bg-nova-deep flex flex-col shrink-0 h-full rounded-r-xl m-2 ml-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
      {/* Tab bar header */}
      <div className="flex items-center border-b border-nova-border shrink-0">
        <button
          onClick={() => onTabChange('chat')}
          className={`flex-1 flex items-center justify-center gap-2 h-11 text-[13px] font-medium transition-colors cursor-pointer border-b-2 ${
            activeTab === 'chat'
              ? 'border-nova-violet text-nova-text'
              : 'border-transparent text-nova-text-muted hover:text-nova-text-secondary'
          }`}
        >
          <Icon icon={ciMessage} width="16" height="16" />
          Chat
        </button>
        <button
          onClick={() => onTabChange('structure')}
          className={`flex-1 flex items-center justify-center gap-2 h-11 text-[13px] font-medium transition-colors cursor-pointer border-b-2 ${
            activeTab === 'structure'
              ? 'border-nova-violet text-nova-text'
              : 'border-transparent text-nova-text-muted hover:text-nova-text-secondary'
          }`}
        >
          <Icon icon={tablerListTree} width="16" height="16" />
          Structure
        </button>
        <button
          onClick={onClose}
          className="px-3 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
        >
          <Icon icon={ciChevronLeft} width="14" height="14" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col relative">
        {/* Chat stays mounted to preserve scroll position — hidden via CSS when structure tab active */}
        <div className={
          activeTab === 'chat'
            ? 'flex flex-col flex-1 min-h-0'
            : 'flex flex-col absolute inset-0 overflow-hidden invisible pointer-events-none'
        }>
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
        {activeTab === 'structure' && (
          <ErrorBoundary>
            <AppTree
              data={builder.treeData}
              selected={builder.selected}
              onSelect={onTreeSelect}
              phase={builder.phase}
              hideHeader
              compact
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}
