/**
 * Module-level store for header visibility on builder pages.
 *
 * The global AppHeader uses this to coordinate with BuilderLayout:
 * - Builder sets `setHeaderVisible(false)` when in centered/hero mode
 * - Builder sets `setHeaderVisible(true)` when generation starts (expanded mode)
 * - AppHeader subscribes via `useSyncExternalStore` to control CSS grid collapse
 *
 * Uses the useSyncExternalStore contract (subscribe + getSnapshot) so React
 * batches the header reveal into the same render pass as the builder's hero
 * Logo unmount — enabling smooth Motion layoutId animation between the two.
 */

type Listener = () => void

let visible = true
const listeners = new Set<Listener>()

/** Set whether the global header should be visible on builder pages. */
export function setHeaderVisible(value: boolean): void {
  if (visible === value) return
  visible = value
  listeners.forEach(l => l())
}

/** useSyncExternalStore snapshot — current visibility state. */
export function getHeaderVisible(): boolean {
  return visible
}

/** useSyncExternalStore snapshot for SSR — always visible (header renders server-side). */
export function getHeaderVisibleServer(): boolean {
  return true
}

/** useSyncExternalStore subscribe callback. */
export function subscribeHeaderVisible(callback: Listener): () => void {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}
