'use client'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciArrowLeftMd from '@iconify-icons/ci/arrow-left-md'
import ciArrowUpMd from '@iconify-icons/ci/arrow-up-md'
import { SCREEN_TRANSITION } from './screenTransition'

interface ScreenNavButtonsProps {
  canGoBack?: boolean
  canGoUp?: boolean
  onBack?: () => void
  onUp?: () => void
  /** Smaller variant for the fixed header bar (18px icons, p-1). Default is 20px/p-1.5. */
  compact?: boolean
  /** Skip the counter-slide animation (e.g. when rendered outside AnimatePresence). */
  static?: boolean
}

const btnClass = (enabled: boolean, compact: boolean) =>
  `${compact ? 'p-1' : 'p-1.5'} rounded-md shrink-0 ${enabled ? 'text-nova-text-muted hover:text-nova-text hover:bg-pv-elevated cursor-pointer' : 'text-nova-text-muted/30 cursor-default'}`

/**
 * Nav buttons for screen headers (back + up). When rendered inside an
 * AnimatePresence screen transition, the counter-sliding motion.div cancels
 * the parent's x-offset so buttons stay visually pinned.
 */
export function ScreenNavButtons({ canGoBack, canGoUp, onBack, onUp, compact, static: isStatic }: ScreenNavButtonsProps) {
  const iconSize = compact ? 18 : 20
  const Wrapper = isStatic ? 'div' : motion.div
  const wrapperProps = isStatic ? {} : {
    initial: SCREEN_TRANSITION.counterInitial,
    animate: SCREEN_TRANSITION.counterAnimate,
    transition: SCREEN_TRANSITION.transition,
  }

  return (
    <Wrapper
      {...wrapperProps}
      className={`flex items-center gap-0.5 ${compact ? '-ml-1' : '-ml-1.5'}`}
    >
      <button onClick={onBack} disabled={!canGoBack} className={btnClass(canGoBack ?? false, !!compact)}>
        <Icon icon={ciArrowLeftMd} width={iconSize} height={iconSize} />
      </button>
      <button onClick={onUp} disabled={!canGoUp} className={btnClass(canGoUp ?? false, !!compact)}>
        <Icon icon={ciArrowUpMd} width={iconSize} height={iconSize} />
      </button>
    </Wrapper>
  )
}
