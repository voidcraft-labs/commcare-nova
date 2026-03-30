/**
 * Shared screen transition config used by PreviewShell's AnimatePresence
 * and ScreenNavButtons' counter-animation. Keeping these in sync prevents
 * the nav buttons from drifting during screen transitions.
 */

const SLIDE_DISTANCE = 20
const DURATION = 0.2
const EASING = [0.4, 0, 0.2, 1] as const

export const SCREEN_TRANSITION = {
  initial: { opacity: 0, x: SLIDE_DISTANCE },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -SLIDE_DISTANCE },
  transition: { duration: DURATION, ease: EASING },
  /** Counter-slide for elements that should stay pinned during the transition. */
  counterInitial: { x: -SLIDE_DISTANCE },
  counterAnimate: { x: 0 },
} as const
