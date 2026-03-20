'use client'
import { Fragment, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciUndo from '@iconify-icons/ci/undo'
import ciRedo from '@iconify-icons/ci/redo'
import { ViewModeToggle } from '@/components/preview/ViewModeToggle'
import { useDismissRef } from '@/hooks/useDismissRef'

/** A breadcrumb segment with a label and navigation callback. */
export interface BreadcrumbPart {
  label: string
  onClick: () => void
}

interface SubheaderToolbarProps {
  /** Current view mode (overview / design / preview). */
  viewMode: 'overview' | 'design' | 'preview'
  /** Callback when view mode toggle changes. */
  onViewModeChange: (mode: 'overview' | 'design' | 'preview') => void
  /** Whether the undo action is available. */
  canUndo: boolean
  /** Whether the redo action is available. */
  canRedo: boolean
  /** Callback for undo. */
  onUndo: () => void
  /** Callback for redo. */
  onRedo: () => void
}

/** Breadcrumb that collapses middle segments behind an ellipsis menu when depth > 3. */
export function CollapsibleBreadcrumb({ parts }: { parts: BreadcrumbPart[] }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const dismissRef = useDismissRef(() => setMenuOpen(false))

  if (parts.length === 0) return null

  // Single item — just the current location
  if (parts.length === 1) {
    return (
      <nav className="flex items-center text-lg min-w-0">
        <span className="text-nova-text font-medium shrink-0 whitespace-nowrap" title={parts[0].label}>
          {parts[0].label}
        </span>
      </nav>
    )
  }

  const first = parts[0]
  const last = parts[parts.length - 1]
  const middle = parts.slice(1, -1)
  const needsCollapse = middle.length > 1

  return (
    <nav className="flex items-center gap-1 text-lg min-w-0">
      {/* First — always an ancestor link */}
      <button
        onClick={first.onClick}
        title={first.label}
        className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer shrink-0 whitespace-nowrap"
      >
        {first.label}
      </button>

      {/* Middle — inline links or collapsed ellipsis */}
      {middle.length > 0 && (
        <>
          <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50 shrink-0" />
          {needsCollapse ? (
            <div ref={dismissRef} className="relative shrink-0">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="text-nova-text-muted hover:text-nova-text hover:bg-nova-surface w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer"
              >
                &hellip;
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.97 }}
                    transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                    className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-[180px] max-w-[280px] rounded-xl border border-nova-border-bright bg-nova-surface/95 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.5)] overflow-hidden py-1"
                  >
                    {middle.map((part, i) => (
                      <button
                        key={i}
                        onClick={() => { part.onClick(); setMenuOpen(false) }}
                        className="w-full px-3 py-2 text-left text-sm text-nova-text-muted hover:text-nova-text hover:bg-nova-elevated/80 transition-colors cursor-pointer truncate"
                      >
                        {part.label}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            middle.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50 shrink-0" />
                )}
                <button
                  onClick={part.onClick}
                  title={part.label}
                  className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer shrink-0 whitespace-nowrap"
                >
                  {part.label}
                </button>
              </Fragment>
            ))
          )}
        </>
      )}

      {/* Chevron + last item — always in the same DOM position */}
      <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50 shrink-0" />
      <span className="text-nova-text font-medium shrink-0 whitespace-nowrap" title={last.label}>
        {last.label}
      </span>
    </nav>
  )
}

/**
 * Subheader toolbar — view mode toggle + undo/redo, spanning the content area.
 * Breadcrumbs and download live in the full-width ProjectSubheader above.
 */
export function SubheaderToolbar({
  viewMode,
  onViewModeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: SubheaderToolbarProps) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center px-4 h-12 border-b border-nova-border shrink-0 bg-nova-deep">
      {/* Left — spacer */}
      <div />

      {/* Center — toggle */}
      <ViewModeToggle mode={viewMode} onChange={onViewModeChange} />

      {/* Right — undo/redo */}
      <div className="flex items-center gap-1.5 justify-end">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="flex items-center gap-1.5 h-[34px] px-2.5 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
          title="Undo (⌘Z)"
        >
          <Icon icon={ciUndo} width="16" height="16" />
          Undo
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="flex items-center gap-1.5 h-[34px] px-2.5 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
          title="Redo (⌘⇧Z)"
        >
          <Icon icon={ciRedo} width="16" height="16" />
          Redo
        </button>
      </div>
    </div>
  )
}
