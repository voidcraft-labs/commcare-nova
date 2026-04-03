/**
 * Right-side header nav links + AccountMenu.
 *
 * Client component — needs `usePathname()` for active state. Accepts `isAdmin`
 * as a prop rather than reading from `useAuth()` to avoid a client session fetch
 * and the resulting flash where the Admin link pops in after hydration. Server
 * pages already resolve the session — they pass `isAdmin` directly.
 *
 * Used internally by PageHeader (server component) and exported for BuilderLayout's
 * floating overlay in centered mode.
 */

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@iconify/react/offline'
import type { IconifyIcon } from '@iconify/react/offline'
import ciFolder from '@iconify-icons/ci/folder'
import tablerUserShield from '@iconify-icons/tabler/user-shield'
import { AccountMenu } from '@/components/ui/AccountMenu'

// ── Nav definition ────────────────────────────────────────────────────

interface NavItem {
  href: string
  label: string
  icon: IconifyIcon
  /** Pathname prefix for active detection (e.g. '/build' matches '/builds' and '/build/abc'). */
  matchPrefix: string
  /** Only render when user has admin role. */
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { href: '/builds', label: 'Projects', icon: ciFolder, matchPrefix: '/build' },
  { href: '/admin', label: 'Admin', icon: tablerUserShield, matchPrefix: '/admin', adminOnly: true },
]

// ── Styles ────────────────────────────────────────────────────────────

function navLinkClass(active: boolean): string {
  const base = 'flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg transition-colors'
  return active
    ? `${base} text-nova-text bg-nova-surface`
    : `${base} text-nova-text-secondary hover:text-nova-text hover:bg-nova-surface`
}

// ── Component ─────────────────────────────────────────────────────────

interface HeaderNavProps {
  /** Whether the current user has admin role — controls visibility of the Admin link. */
  isAdmin?: boolean
}

export function HeaderNav({ isAdmin }: HeaderNavProps) {
  const pathname = usePathname()

  return (
    <div className="flex items-center gap-1">
      {NAV_ITEMS.map(item => {
        if (item.adminOnly && !isAdmin) return null
        const isActive = pathname.startsWith(item.matchPrefix)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={navLinkClass(isActive)}
          >
            <Icon icon={item.icon} width="16" height="16" />
            {item.label}
          </Link>
        )
      })}
      <AccountMenu />
    </div>
  )
}
