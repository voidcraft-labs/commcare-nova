'use client'
import { useEffect, useRef } from 'react'
import { keyboardManager, type Shortcut } from '@/lib/services/keyboardManager'

export function useKeyboardShortcuts(id: string, shortcuts: Shortcut[], deps: any[]) {
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  useEffect(() => {
    keyboardManager.register(id, shortcutsRef.current)
    return () => keyboardManager.unregister(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ...deps])
}
