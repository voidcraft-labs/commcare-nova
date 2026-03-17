'use client'
import { Icon } from '@iconify/react'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'

interface PreviewHeaderProps {
  breadcrumb: string[]
  canGoBack: boolean
  onBack: () => void
  onBreadcrumbClick: (index: number) => void
  actions?: React.ReactNode
}

export function PreviewHeader({ breadcrumb, canGoBack, onBack, onBreadcrumbClick, actions }: PreviewHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-pv-input-border">
      <div className="flex items-center gap-2 min-w-0">
        {canGoBack && (
          <button
            onClick={onBack}
            className="p-1 -ml-1 text-nova-text-secondary hover:text-nova-text transition-colors rounded-md hover:bg-pv-elevated cursor-pointer"
          >
            <Icon icon={ciChevronLeft} width="18" height="18" />
          </button>
        )}
        <div className="flex items-center gap-1.5 text-sm min-w-0 truncate">
          {breadcrumb.map((part, i) => {
            const isLast = i === breadcrumb.length - 1
            return (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-nova-text-muted">/</span>}
                {isLast ? (
                  <span className="text-nova-text font-medium">{part}</span>
                ) : (
                  <button
                    onClick={() => onBreadcrumbClick(i)}
                    className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
                  >
                    {part}
                  </button>
                )}
              </span>
            )
          })}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}
