/**
 * Shared frosted-glass dropdown menu used by ExportDropdown, FormTypeDropdown,
 * and any future toolbar/header dropdowns.
 *
 * Renders a `POPOVER_GLASS` container with uniformly styled menu items.
 * Each item supports an icon, label, optional description, and optional
 * active state (violet highlight + dot indicator).
 *
 * Animation is handled by the parent (either Motion's AnimatePresence or
 * the Web Animations API via `useLayoutEffect`).
 */

'use client'
import { Icon, type IconifyIcon } from '@iconify/react/offline'
import { POPOVER_GLASS } from '@/lib/styles'

export interface DropdownMenuItem {
  /** Unique key for the item. */
  key: string
  /** Display label. */
  label: string
  /** Optional secondary description rendered below the label. */
  description?: string
  /** Icon rendered to the left of the label. */
  icon: IconifyIcon
  /** Click handler — called when the item is selected. */
  onClick: () => void
}

interface DropdownMenuProps {
  items: DropdownMenuItem[]
  /** Key of the currently active item (shows violet highlight + dot). */
  activeKey?: string
  /** Minimum width of the menu container. */
  minWidth?: string
  /** Ref forwarded to the outer container for dismiss handling. */
  menuRef?: React.Ref<HTMLDivElement>
}

/**
 * Frosted-glass dropdown menu with icon + label rows.
 * Matches the FormTypeDropdown visual language: `POPOVER_GLASS` surface,
 * violet dot + highlight for active item, `hover:bg-white/[0.06]`.
 */
export function DropdownMenu({ items, activeKey, minWidth = '160px', menuRef }: DropdownMenuProps) {
  const showDots = activeKey !== undefined
  const last = items.length - 1

  return (
    <div ref={menuRef} className={POPOVER_GLASS} style={{ minWidth }}>
      {items.map((item, i) => {
        const isActive = item.key === activeKey
        /* First/last items inherit the container's border radius so their
         * hover/active backgrounds tile flush against the rounded edges. */
        const corners = i === 0 && i === last
          ? 'rounded-xl'
          : i === 0
            ? 'rounded-t-xl'
            : i === last
              ? 'rounded-b-xl'
              : ''

        return (
          <button
            key={item.key}
            onClick={item.onClick}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${corners} ${
              isActive
                ? 'text-nova-violet-bright bg-nova-violet/10'
                : 'text-nova-text hover:bg-white/[0.06]'
            }`}
          >
            {/* Active dot indicator — only rendered when the menu tracks selection */}
            {showDots && (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-nova-violet' : 'bg-transparent'}`} />
            )}
            <Icon
              icon={item.icon}
              width="16"
              height="16"
              className={isActive ? 'text-nova-violet-bright' : 'text-nova-text-muted'}
            />
            {item.description ? (
              <div className="min-w-0 text-left">
                <div>{item.label}</div>
                <div className={`text-xs leading-tight ${isActive ? 'text-nova-violet-bright/60' : 'text-nova-text-muted'}`}>
                  {item.description}
                </div>
              </div>
            ) : (
              item.label
            )}
          </button>
        )
      })}
    </div>
  )
}
