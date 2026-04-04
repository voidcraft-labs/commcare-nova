/**
 * Global app header — rendered once in the root layout, every page.
 *
 * Always visible on all routes except the landing page (`/`).
 * Mounts a single `HeaderNav` (and therefore a single `AccountMenu`)
 * that persists across navigations — no conditional mount/unmount.
 */

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { HeaderNav } from '@/components/ui/HeaderNav'

interface AppHeaderProps {
  /** Whether the current user has admin role — passed through to HeaderNav. */
  isAdmin: boolean
}

export function AppHeader({ isAdmin }: AppHeaderProps) {
  const pathname = usePathname()

  /* Landing page — no header at all. */
  if (pathname === '/') return null

  return (
    <header className="border-b border-nova-border px-4 py-2.5 flex items-center justify-between bg-nova-void shrink-0">
      <Link href="/builds">
        <Logo size="sm" />
      </Link>
      <HeaderNav isAdmin={isAdmin} />
    </header>
  )
}
