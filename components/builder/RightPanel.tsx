'use client'
import { Icon } from '@iconify/react'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { AppTree } from '@/components/builder/AppTree'
import type { Builder } from '@/lib/services/builder'

interface RightPanelProps {
  builder: Builder
  onClose: () => void
  onTreeSelect: (selection: any) => void
}

export function RightPanel({
  builder,
  onClose,
  onTreeSelect,
}: RightPanelProps) {
  return (
    <div className="w-80 border border-nova-border-bright border-r-0 bg-nova-deep flex flex-col shrink-0 h-full rounded-l-xl m-2 mr-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
        <span className="text-[13px] font-medium text-nova-text-secondary">Structure</span>
        <button
          onClick={onClose}
          className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
        >
          <Icon icon={ciChevronRight} width="14" height="14" />
        </button>
      </div>

      {/* Structure tree */}
      <div className="flex-1 overflow-hidden flex flex-col">
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
      </div>
    </div>
  )
}
