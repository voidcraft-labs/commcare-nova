/**
 * Global app header — rendered once in the root layout, every page.
 *
 * Route-aware rendering via `usePathname()`:
 * - Landing (`/`): returns null — no header
 * - Builder (`/build/*`): CSS grid collapse controlled by headerVisibility store.
 *   Logo wrapped in `motion.div layoutId="nova-logo"` for shared layout animation
 *   with the builder's centered hero Logo. HeaderNav only mounts when visible to
 *   avoid duplicate AccountMenu fetches and ARIA landmarks (builder renders its
 *   own floating HeaderNav during centered mode).
 * - All other routes: always visible, static Logo, HeaderNav always mounted.
 *
 * The CSS grid collapse (gridTemplateRows 0fr → 1fr) syncs with Motion's
 * layoutId animation on the Logo (450ms cubic-bezier).
 */

'use client'

import { useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'motion/react'
import { Logo } from '@/components/ui/Logo'
import { HeaderNav } from '@/components/ui/HeaderNav'
import {
  subscribeHeaderVisible,
  getHeaderVisible,
  getHeaderVisibleServer,
} from '@/lib/stores/headerVisibility'
import { EASE } from '@/lib/animations'

interface AppHeaderProps {
  /** Whether the current user has admin role — passed through to HeaderNav. */
  isAdmin: boolean
}

export function AppHeader({ isAdmin }: AppHeaderProps) {
  const pathname = usePathname()
  const builderRevealed = useSyncExternalStore(
    subscribeHeaderVisible,
    getHeaderVisible,
    getHeaderVisibleServer,
  )

  /* Landing page — no header at all. */
  if (pathname === '/') return null

  const isBuilder = pathname.startsWith('/build/')
  const isVisible = isBuilder ? builderRevealed : true

  return (
    <div
      className="grid shrink-0"
      style={{
        gridTemplateRows: isVisible ? '1fr' : '0fr',
        /* Only animate on builder routes — other pages show the header instantly. */
        transition: isBuilder
          ? `grid-template-rows 450ms cubic-bezier(${EASE.join(',')})`
          : 'none',
      }}
    >
      <div className="overflow-hidden">
        <header className="border-b border-nova-border px-4 py-2.5 flex items-center justify-between bg-nova-void">
          {/* On builder routes, Logo participates in the shared layout animation
           *  with the centered hero Logo via layoutId. On other routes it's static. */}
          {isBuilder ? (
            <motion.div
              layoutId="nova-logo"
              className="cursor-pointer"
              transition={{ layout: { duration: 0.45, ease: EASE } }}
            >
              <Link href="/">
                <Logo size="sm" />
              </Link>
            </motion.div>
          ) : (
            <Link href="/">
              <Logo size="sm" />
            </Link>
          )}

          {/* HeaderNav only mounts when header is visible to avoid duplicate
           *  instances — builder renders its own floating HeaderNav in centered mode. */}
          {isVisible && <HeaderNav isAdmin={isAdmin} />}
        </header>
      </div>
    </div>
  )
}
