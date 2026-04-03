'use client'
import { Icon } from '@iconify/react/offline'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import { motion, AnimatePresence } from 'motion/react'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { AppTree } from '@/components/builder/AppTree'
import { BuilderPhase, type Builder } from '@/lib/services/builder'

interface StructureSidebarProps {
  builder: Builder
  onClose: () => void
  onTreeSelect: (selection: any) => void
}

export function StructureSidebar({
  builder,
  onClose,
  onTreeSelect,
}: StructureSidebarProps) {
  return (
    <div className="w-80 border-r border-nova-border-bright bg-nova-deep flex flex-col shrink-0 h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
        <button
          onClick={onClose}
          className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
        >
          <Icon icon={ciChevronLeft} width="14" height="14" />
        </button>
        <span className="text-[13px] font-medium text-nova-text-secondary">Structure</span>
      </div>

      {/* Structure tree */}
      <div className="flex-1 overflow-hidden flex flex-col relative">
        <ErrorBoundary>
          <AppTree
            data={builder.treeData}
            selected={builder.selected}
            onSelect={onTreeSelect}
            phase={builder.phase}
            hideHeader
          />
        </ErrorBoundary>

        {/* Dim overlay — blocks interaction until generation completes */}
        <AnimatePresence>
          {builder.phase !== BuilderPhase.Ready && (
            <motion.div
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 bg-black/25 z-10 pointer-events-none"
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
