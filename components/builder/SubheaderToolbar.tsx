'use client'
import { Fragment, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciUndo from '@iconify-icons/ci/undo'
import ciRedo from '@iconify-icons/ci/redo'
import ciFileDocument from '@iconify-icons/ci/file-document'
import ciDownloadPackage from '@iconify-icons/ci/download-package'
import { PreviewToggle } from '@/components/preview/PreviewToggle'
import { useDismissRef } from '@/hooks/useDismissRef'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'

/** A breadcrumb segment with a label and navigation callback. */
export interface BreadcrumbPart {
  label: string
  onClick: () => void
}

interface SubheaderToolbarProps {
  /** Breadcrumb segments derived from nav stack (design/preview) or selection (tree). */
  breadcrumbParts: BreadcrumbPart[]
  /** Current view mode (tree / design / preview). */
  viewMode: 'tree' | 'design' | 'preview'
  /** Callback when view mode toggle changes. */
  onViewModeChange: (mode: 'tree' | 'design' | 'preview') => void
  /** Whether the undo action is available. */
  canUndo: boolean
  /** Whether the redo action is available. */
  canRedo: boolean
  /** Callback for undo. */
  onUndo: () => void
  /** Callback for redo. */
  onRedo: () => void
  /** Callback to download JSON export. */
  onDownloadJson: () => void
  /** Callback to compile and download CCZ. */
  onCompile: () => void
}

/** Breadcrumb that collapses middle segments behind an ellipsis menu when depth > 3. */
function CollapsibleBreadcrumb({ parts }: { parts: BreadcrumbPart[] }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const dismissRef = useDismissRef(() => setMenuOpen(false))

  if (parts.length === 0) return null

  // Single item — just the current location
  if (parts.length === 1) {
    return (
      <nav className="flex items-center text-sm min-w-0">
        <span className="text-nova-text font-medium shrink-0 max-w-[50%] truncate" title={parts[0].label}>
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
    <nav className="flex items-center gap-1 text-sm min-w-0">
      {/* First — always an ancestor link */}
      <button
        onClick={first.onClick}
        title={first.label}
        className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer truncate max-w-[200px] min-w-0 shrink-[3]"
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
                    className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-[180px] max-w-[280px] rounded-lg border border-nova-border bg-nova-surface/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden py-1"
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
                  className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer truncate max-w-[200px] min-w-0 shrink-[3]"
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
      <span className="text-nova-text font-medium shrink-0 max-w-[50%] truncate" title={last.label}>
        {last.label}
      </span>
    </nav>
  )
}

/**
 * Subheader toolbar — sits below the main header, spanning the full width of the builder area.
 * 3-column grid: left breadcrumbs, center PreviewToggle, right undo/redo + download.
 */
export function SubheaderToolbar({
  breadcrumbParts,
  viewMode,
  onViewModeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDownloadJson,
  onCompile,
}: SubheaderToolbarProps) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center px-4 gap-8 h-16 border-b border-nova-border shrink-0">
      {/* Left — breadcrumbs (all view modes) */}
      <CollapsibleBreadcrumb parts={breadcrumbParts} />

      {/* Center — toggle */}
      <PreviewToggle mode={viewMode} onChange={onViewModeChange} />

      {/* Right — undo/redo + download */}
      <div className="flex items-center gap-1.5 justify-end">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
          title="Undo (⌘Z)"
        >
          <Icon icon={ciUndo} width="16" height="16" />
          Undo
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
          title="Redo (⌘⇧Z)"
        >
          <Icon icon={ciRedo} width="16" height="16" />
          Redo
        </button>
        <DownloadDropdown
          options={[
            {
              label: 'JSON',
              description: 'For CommCare HQ',
              icon: <Icon icon={ciFileDocument} width="28" height="28" />,
              onClick: onDownloadJson,
            },
            {
              label: 'CCZ',
              description: 'For CommCare',
              icon: <Icon icon={ciDownloadPackage} width="28" height="28" />,
              onClick: onCompile,
            },
          ]}
        />
      </div>
    </div>
  )
}
