'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { keyboardManager, type Shortcut } from '@/lib/services/keyboardManager'

/**
 * Register keyboard shortcuts with the global KeyboardManager.
 * Uses useSyncExternalStore's subscribe lifecycle for mount/unmount/update.
 * The snapshot is constant (0) — we only use the subscribe/cleanup cycle.
 */
export function useKeyboardShortcuts(id: string, shortcuts: Shortcut[], deps: any[]) {
  const subscribe = useCallback((_notify: () => void) => {
    keyboardManager.register(id, shortcuts)
    return () => keyboardManager.unregister(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ...deps])
  useSyncExternalStore(subscribe, () => 0, () => 0)
}
