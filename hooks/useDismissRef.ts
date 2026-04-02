import { useCallback, useRef } from 'react'

/**
 * Returns a stable ref callback that registers dismiss listeners (click-outside + Escape)
 * via React 19 ref callback cleanup.
 *
 * Attach to the container element — clicks outside it or Escape presses trigger onDismiss.
 *
 * Best for inline dropdowns where the trigger lives inside the container DOM.
 * For FloatingPortal-based dropdowns (trigger outside the portal), use
 * `useFloatingDropdown` instead — it handles trigger-awareness internally.
 */
export function useDismissRef(onDismiss: () => void) {
  // Ref keeps callback current without changing the ref callback identity
  const callbackRef = useRef(onDismiss)
  callbackRef.current = onDismiss

  return useCallback((el: HTMLElement | null): (() => void) | void => {
    if (!el) return
    const onMouseDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) callbackRef.current()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') callbackRef.current()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
