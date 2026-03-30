/**
 * Shared screen transition config used by PreviewShell's AnimatePresence
 * for slide animations between screens.
 */

const SLIDE_DISTANCE = 20
const DURATION = 0.2
const EASING = [0.4, 0, 0.2, 1] as const

export const SCREEN_TRANSITION = {
  initial: { opacity: 0, x: SLIDE_DISTANCE },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -SLIDE_DISTANCE },
  transition: { duration: DURATION, ease: EASING },
} as const
