/**
 * Skeleton loading placeholder — renders a shimmer bar or circle.
 *
 * Uses a horizontal gradient sweep animation that's visible on the dark
 * Nova theme. The gradient moves from `--nova-surface` through a faint
 * violet-tinted highlight and back, creating a polished shimmer effect.
 *
 * Server component — no `'use client'` needed. Meant to be composed into
 * page-specific skeleton layouts (loading.tsx files, Suspense fallbacks).
 */

interface SkeletonProps {
  /** Shape variant. `bar` = rounded rectangle, `circle` = round. */
  variant?: 'bar' | 'circle'
  /** Additional Tailwind classes for sizing (w-*, h-*). */
  className?: string
  /** Inline styles — merged with the shimmer gradient. */
  style?: React.CSSProperties
}

/** Base gradient style — creates the horizontal shimmer sweep. */
const SHIMMER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(90deg, var(--nova-surface) 0%, rgba(139, 92, 246, 0.06) 40%, var(--nova-surface) 80%)',
  backgroundSize: '200% 100%',
}

export function Skeleton({ variant = 'bar', className = '', style }: SkeletonProps) {
  return (
    <div
      className={`animate-shimmer ${variant === 'circle' ? 'rounded-full' : 'rounded-md'} ${className}`}
      style={style ? { ...SHIMMER_STYLE, ...style } : SHIMMER_STYLE}
      aria-hidden="true"
    />
  )
}
