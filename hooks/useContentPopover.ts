'use client'
import { useEffect, useRef } from 'react'

/**
 * Module-level singleton store for coordinating content popovers in the main
 * content area (beneath header/subheaders, inside design/preview content).
 *
 * Content popovers — form settings, form type dropdown, app connect settings,
 * etc. — are on the same visual "layer" and should dismiss when a competing
 * interaction starts (e.g. clicking an insertion point to add a question).
 *
 * Each popover registers its dismiss callback on mount and unregisters on
 * unmount. Consumers like InsertionPoint call `dismissContentPopovers()` to
 * clear the deck before opening their own UI.
 */

type DismissFn = () => void

/** Currently active content popover dismiss callbacks. */
const active = new Set<DismissFn>()

/**
 * Register a content popover's dismiss callback.
 * Returns an unregister function (call on unmount / popover close).
 */
export function registerContentPopover(dismiss: DismissFn): () => void {
  active.add(dismiss)
  return () => { active.delete(dismiss) }
}

/**
 * Dismiss all active content popovers in the main content area.
 * Returns true if any were dismissed (useful for callers deciding
 * whether to proceed with their own action).
 */
export function dismissContentPopovers(): boolean {
  if (active.size === 0) return false
  /* Snapshot before clearing — dismiss callbacks may trigger re-renders
     that unmount the popover and call the unregister cleanup. Working
     from a snapshot avoids mutating the set during iteration. */
  const snapshot = [...active]
  active.clear()
  for (const fn of snapshot) fn()
  return true
}

/**
 * Hook that registers a content popover for coordinated dismissal.
 * When `enabled` is true (default), the popover is registered; when false,
 * it unregisters. This handles both conditionally-rendered popovers
 * (always enabled, mount/unmount controls lifecycle) and always-mounted
 * components that toggle visibility via early returns (pass the visibility
 * flag as `enabled`).
 *
 * The `onDismiss` callback is captured by ref so the hook never re-registers
 * when the callback identity changes.
 */
export function useContentPopoverDismiss(onDismiss: () => void, enabled = true): void {
  const ref = useRef(onDismiss)
  ref.current = onDismiss
  useEffect(() => {
    if (!enabled) return
    return registerContentPopover(() => ref.current())
  }, [enabled])
}
