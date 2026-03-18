'use client'
import { Icon } from '@iconify/react'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciUndo from '@iconify-icons/ci/undo'
import ciRedo from '@iconify-icons/ci/redo'
import ciFileDocument from '@iconify-icons/ci/file-document'
import ciDownloadPackage from '@iconify-icons/ci/download-package'
import { PreviewToggle } from '@/components/preview/PreviewToggle'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'

/** A breadcrumb segment with a label and navigation callback. */
export interface BreadcrumbPart {
  label: string
  onClick: () => void
}

interface SubheaderToolbarProps {
  /** Breadcrumb segments derived from nav stack (preview/live) or selection (tree). */
  breadcrumbParts: BreadcrumbPart[]
  /** Current view mode (tree / preview / test). */
  viewMode: 'tree' | 'preview' | 'test'
  /** Callback when view mode toggle changes. */
  onViewModeChange: (mode: 'tree' | 'preview' | 'test') => void
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
    <div className="grid grid-cols-[1fr_auto_1fr] items-center px-4 h-16 border-b border-nova-border shrink-0">
      {/* Left — breadcrumbs (all view modes) */}
      <div className="flex items-center min-w-0">
        <nav className="flex items-center gap-1 text-sm min-w-0 truncate">
          {breadcrumbParts.map((part, i) => {
            const isLast = i === breadcrumbParts.length - 1
            return (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && (
                  <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50" />
                )}
                {isLast ? (
                  <span className="text-nova-text font-medium truncate">{part.label}</span>
                ) : (
                  <button
                    onClick={part.onClick}
                    className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {part.label}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
      </div>

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
