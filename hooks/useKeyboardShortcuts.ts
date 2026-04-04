'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { keyboardManager, type Shortcut } from '@/lib/services/keyboardManager'

/**
 * Register keyboard shortcuts with the global KeyboardManager.
 * Uses useSyncExternalStore's subscribe lifecycle for mount/unmount/update.
 * The snapshot is constant (0) — we only use the subscribe/cleanup cycle.
 *
 * `shortcuts` should be memoized by the caller (useMemo) so the subscribe
 * callback only regenerates when the shortcut definitions actually change.
 */
export function useKeyboardShortcuts(id: string, shortcuts: Shortcut[]) {
  const subscribe = useCallback((_notify: () => void) => {
    keyboardManager.register(id, shortcuts)
    return () => keyboardManager.unregister(id)
  }, [id, shortcuts])
  useSyncExternalStore(subscribe, () => 0, () => 0)
}
