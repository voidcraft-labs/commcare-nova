'use client'
import { Fragment, memo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import { useDismissRef } from '@/hooks/useDismissRef'

/** A breadcrumb segment with a label and navigation callback. */
export interface BreadcrumbPart {
  label: string
  onClick: () => void
}

/** Chevron separator rendered between breadcrumb segments. */
const Chevron = <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50 shrink-0" />

/** Shared base styles for all segments. Both ancestor and current use font-medium
 *  so the rendered text width stays constant when a segment transitions between
 *  states — preventing content shift from font-weight changes. */
const SEGMENT_BASE = 'font-medium shrink-0 whitespace-nowrap'

/** Ancestor segment — muted text, clickable to navigate up. */
const ANCESTOR_CLASS = `${SEGMENT_BASE} text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer`

/** Current segment — bright text, non-interactive. */
const CURRENT_CLASS = `${SEGMENT_BASE} text-nova-text cursor-default`

/**
 * Deep equality check for BreadcrumbPart arrays. Compares labels by value
 * and onClick by reference, so the component only re-renders when the visible
 * breadcrumb text changes (e.g. inline title edit) or the navigation structure
 * changes (different handler references from a new breadcrumbPath).
 */
function breadcrumbPartsEqual(prev: { parts: BreadcrumbPart[] }, next: { parts: BreadcrumbPart[] }): boolean {
  const a = prev.parts, b = next.parts
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].label !== b[i].label || a[i].onClick !== b[i].onClick) return false
  }
  return true
}

/**
 * Navigable breadcrumb trail for the Tier 2 project subheader.
 *
 * Uses a single, stable DOM structure via `.map()` over all parts — every segment
 * is a `<button>` element, just styled differently for ancestor vs. current. This
 * prevents the layout-shifting teardown/rebuild that occurs when depth changes
 * cause branching render paths (e.g. 1-part vs 2-part layouts). Adding a new
 * depth level only appends elements; existing elements update in place.
 *
 * Collapses middle segments behind an ellipsis dropdown when depth > 3.
 * Wrapped in `memo` with deep part comparison to skip re-renders from unrelated
 * BuilderLayout state changes (chat messages, selection, etc.).
 */
export const CollapsibleBreadcrumb = memo(function CollapsibleBreadcrumb({ parts }: { parts: BreadcrumbPart[] }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const dismissRef = useDismissRef(() => setMenuOpen(false))

  if (parts.length === 0) return null

  /* Middle segments that get collapsed behind an ellipsis when depth > 3 */
  const needsCollapse = parts.length > 3
  const collapsedMiddle = needsCollapse ? parts.slice(1, -1) : []

  return (
    <nav className="flex items-center gap-1 text-lg min-w-0">
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1

        /* ── Collapsed middle: render ellipsis menu at index 1, skip rest ── */
        if (needsCollapse && i > 0 && i < parts.length - 1) {
          /* Only the first collapsed slot renders the ellipsis; the rest are hidden */
          if (i !== 1) return null
          return (
            <Fragment key="collapse">
              {Chevron}
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
                      className="absolute left-0 top-[calc(100%+4px)] z-popover min-w-[180px] max-w-[280px] rounded-xl border border-nova-border-bright bg-nova-surface/95 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.5)] overflow-hidden py-1"
                    >
                      {collapsedMiddle.map((mp, mi) => (
                        <button
                          key={mi}
                          onClick={() => { mp.onClick(); setMenuOpen(false) }}
                          className="w-full px-3 py-2 text-left text-sm text-nova-text-muted hover:text-nova-text hover:bg-nova-elevated/80 transition-colors cursor-pointer truncate"
                        >
                          {mp.label}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </Fragment>
          )
        }

        /* ── Standard segment: chevron (if not first) + button ── */
        return (
          <Fragment key={i}>
            {i > 0 && Chevron}
            <button
              onClick={isLast ? undefined : part.onClick}
              title={part.label}
              className={isLast ? CURRENT_CLASS : ANCESTOR_CLASS}
            >
              {part.label}
            </button>
          </Fragment>
        )
      })}
    </nav>
  )
}, breadcrumbPartsEqual)
