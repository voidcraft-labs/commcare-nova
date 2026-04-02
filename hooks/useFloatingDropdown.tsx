/**
 * Composable hook + portal component for FloatingPortal-based dropdowns.
 *
 * Encapsulates the full lifecycle that every portal dropdown needs:
 * - Open/close state with a toggle function
 * - FloatingUI positioning (offset, flip, shift, autoUpdate)
 * - Entrance animation (shared POPOVER_ENTER_KEYFRAMES)
 * - Click-outside + Escape dismiss (trigger-aware — no race condition)
 * - Optional content popover coordination (mutual dismissal)
 *
 * The hook owns both the trigger and content refs, so it can distinguish
 * "click on trigger" (let the toggle handle it) from "click outside"
 * (dismiss) without any ref-exclusion plumbing.
 *
 * Usage:
 * ```tsx
 * function MyDropdown() {
 *   const dd = useFloatingDropdown<HTMLButtonElement>()
 *   return (
 *     <>
 *       <button ref={dd.triggerRef} onClick={dd.toggle}>Open</button>
 *       <DropdownPortal dropdown={dd}>
 *         <Panel onClose={dd.close} />
 *       </DropdownPortal>
 *     </>
 *   )
 * }
 * ```
 *
 * For panels that need custom dismiss guards (e.g. ignoring clicks on
 * CodeMirror autocomplete tooltips), pass a `shouldDismiss` predicate.
 */

'use client'
import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useFloating, offset as floatingOffset, flip, shift, size as floatingSize, autoUpdate, FloatingPortal, type Placement } from '@floating-ui/react'
import { POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS } from '@/lib/animations'
import { useContentPopoverDismiss } from './useContentPopover'

export interface FloatingDropdownOptions {
  /** Popover placement relative to the trigger. Default: `'bottom-end'`. */
  placement?: Placement
  /** Pixel offset from the trigger edge. Default: `8`. */
  offset?: number
  /**
   * Guard predicate called on every dismiss attempt (outside-click or Escape).
   * Return `false` to block the dismiss (e.g. when a CodeMirror autocomplete
   * tooltip has focus). Default: always dismisses.
   */
  shouldDismiss?: () => boolean
  /**
   * Register with the content popover coordination system so this dropdown
   * is dismissed when another content popover opens (and vice versa).
   * Use for popovers in the main content area (form settings, form type,
   * connect settings). Don't use for popovers on separate layers (account
   * menu, type picker inside the contextual editor).
   */
  contentPopover?: boolean
  /**
   * Size the dropdown to match the trigger element's width. Use for
   * form-field dropdowns where the menu should feel like an extension
   * of the input (e.g. select menus). The trigger width is applied as
   * a CSS `min-width` so the dropdown can still grow for wider content.
   */
  matchTriggerWidth?: boolean
}

export interface FloatingDropdown<T extends HTMLElement = HTMLElement> {
  /** Whether the dropdown is currently open. */
  open: boolean
  /** Toggle open state — intended as the trigger's onClick handler. */
  toggle: () => void
  /** Close the dropdown unconditionally. */
  close: () => void
  /**
   * Attach to the trigger element. Doubles as the FloatingUI reference
   * anchor and the dismiss-exclusion target.
   */
  triggerRef: RefObject<T | null>
  /**
   * Ref callback for the portal content wrapper. Registers the element
   * with FloatingUI for positioning — no side effects, no cleanup needed.
   */
  contentRef: (el: HTMLDivElement | null) => void
  /** Inline styles from FloatingUI — spread onto the content wrapper. */
  floatingStyles: CSSProperties
}

export function useFloatingDropdown<T extends HTMLElement = HTMLElement>(
  options?: FloatingDropdownOptions,
): FloatingDropdown<T> {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<T>(null)
  const contentElRef = useRef<HTMLDivElement | null>(null)

  /* Guard predicate stored in a ref so the dismiss effect always reads
   * the latest value without re-subscribing listeners on every render. */
  const shouldDismissRef = useRef(options?.shouldDismiss)
  shouldDismissRef.current = options?.shouldDismiss

  /* Memoize middleware to avoid recreating the array on every render,
   * which would trigger unnecessary FloatingUI recomputation. */
  const pixelOffset = options?.offset ?? 8
  const matchWidth = options?.matchTriggerWidth ?? false
  const middleware = useMemo(() => [
    floatingOffset(pixelOffset),
    flip(),
    shift({ padding: 12 }),
    /* When matchTriggerWidth is set, apply the trigger's width as the
     * floating element's min-width so it feels like an inline select. */
    ...(matchWidth ? [floatingSize({
      apply({ rects, elements }) {
        elements.floating.style.minWidth = `${rects.reference.width}px`
      },
    })] : []),
  ], [pixelOffset, matchWidth])

  /* FloatingUI positioning — offset/flip/shift with live autoUpdate. */
  const { refs, floatingStyles } = useFloating({
    placement: options?.placement ?? 'bottom-end',
    middleware,
    whileElementsMounted: autoUpdate,
  })

  /* Wire the trigger as the FloatingUI reference element. */
  useLayoutEffect(() => {
    if (triggerRef.current) refs.setReference(triggerRef.current)
  }, [refs])

  const toggle = useCallback(() => setOpen(o => !o), [])
  const close = useCallback(() => setOpen(false), [])

  /* Content popover coordination — register only while open so closed
   * dropdowns aren't spuriously dismissed by other popovers opening. */
  useContentPopoverDismiss(close, !!(options?.contentPopover && open))

  /* Entrance animation — runs in useLayoutEffect so it starts before
   * the browser's first paint. FloatingUI's internal layoutEffect fires
   * first (declared earlier via useFloating) and synchronously repositions
   * the element, so by the time this effect runs the element is at its
   * final position. The animation begins at opacity: 0 regardless, so
   * even if a transient default-position frame existed it'd be invisible. */
  useLayoutEffect(() => {
    if (open) contentElRef.current?.animate(POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS)
  }, [open])

  /* Dismiss listeners — only attached while the dropdown is open.
   * Owns both trigger and content awareness directly, so there's no
   * need for useDismissRef's excludeRef plumbing. Clicks on the trigger
   * are ignored here (the trigger's own onClick toggle handles close). */
  useEffect(() => {
    if (!open) return

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (contentElRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      if (shouldDismissRef.current && !shouldDismissRef.current()) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (shouldDismissRef.current && !shouldDismissRef.current()) return
      setOpen(false)
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /* Pure ref-setter — registers the element with FloatingUI and stores
   * it locally for the animation/dismiss effects. */
  const contentRef = useCallback((el: HTMLDivElement | null) => {
    contentElRef.current = el
    refs.setFloating(el)
  }, [refs])

  return { open, toggle, close, triggerRef, contentRef, floatingStyles } satisfies FloatingDropdown<T>
}

// ── Portal wrapper ───────────────────────────────────────────────────

interface DropdownPortalProps<T extends HTMLElement> extends Omit<React.HTMLAttributes<HTMLDivElement>, 'ref' | 'style'> {
  dropdown: FloatingDropdown<T>
  children: ReactNode
}

/**
 * Thin wrapper that renders the FloatingPortal + positioned content div
 * when the dropdown is open. Eliminates the repeated `{dd.open && (
 * <FloatingPortal><div ref style className>...` boilerplate from every
 * consumer. Pass `className` to override the default `z-popover` layer,
 * and any extra div props (e.g. `onClick`) are spread onto the wrapper.
 */
export function DropdownPortal<T extends HTMLElement>({
  dropdown,
  className = 'z-popover',
  children,
  ...divProps
}: DropdownPortalProps<T>) {
  if (!dropdown.open) return null
  return (
    <FloatingPortal>
      <div ref={dropdown.contentRef} style={dropdown.floatingStyles} className={className} {...divProps}>
        {children}
      </div>
    </FloatingPortal>
  )
}
