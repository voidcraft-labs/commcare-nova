'use client'
import { ScreenNavButtons } from './ScreenNavButtons'

interface PreviewHeaderProps {
  breadcrumb: string[]
  canGoBack: boolean
  canGoUp: boolean
  onBack: () => void
  onUp: () => void
  onBreadcrumbClick: (index: number) => void
  actions?: React.ReactNode
}

export function PreviewHeader({ breadcrumb, canGoBack, canGoUp, onBack, onUp, onBreadcrumbClick, actions }: PreviewHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 h-12 border-b border-nova-border">
      <div className="flex items-center gap-2 min-w-0">
        <ScreenNavButtons canGoBack={canGoBack} canGoUp={canGoUp} onBack={onBack} onUp={onUp} compact static />
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
