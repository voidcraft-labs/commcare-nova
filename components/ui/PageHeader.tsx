/**
 * Unified page header — one server component, every page.
 *
 * Layout: [back?] [Logo] [breadcrumb?] ........... [Projects] [Admin?] [AccountMenu]
 *
 * Server-rendered structure with `HeaderNav` (client leaf) for the interactive
 * nav links and account menu. `isAdmin` flows from the server page's session
 * through to HeaderNav — no client session fetch needed.
 */

import Link from 'next/link'
import { Icon } from '@iconify/react/offline'
import ciArrowLeftSm from '@iconify-icons/ci/arrow-left-sm'
import { Logo } from '@/components/ui/Logo'
import { NAV_ICON_CLASS } from '@/lib/styles'
import { HeaderNav } from '@/components/ui/HeaderNav'

// ── Types ─────────────────────────────────────────────────────────────

interface BreadcrumbSegment {
  /** Display text. */
  label: string
  /** Optional link — segments without href render as static text. */
  href?: string
}

interface PageHeaderProps {
  /** Whether the current user has admin role — passed through to HeaderNav. */
  isAdmin?: boolean
  /** Back arrow link rendered before the logo. */
  back?: {
    href: string
    label?: string
  }
  /** Breadcrumb trail after the logo, separated by a vertical divider. */
  breadcrumb?: BreadcrumbSegment[]
}

// ── Component ─────────────────────────────────────────────────────────

export function PageHeader({ isAdmin, back, breadcrumb }: PageHeaderProps) {
  return (
    <header className="border-b border-nova-border px-4 py-2.5 flex items-center justify-between">
      {/* ── Left: back + logo + breadcrumb ──────────────────── */}
      <div className="flex items-center gap-4">
        {back && (
          <Link
            href={back.href}
            className={NAV_ICON_CLASS}
            title={back.label ?? 'Go back'}
          >
            <Icon icon={ciArrowLeftSm} width="20" height="20" />
          </Link>
        )}
        <Link href="/">
          <Logo size="sm" />
        </Link>
        {breadcrumb && breadcrumb.length > 0 && (
          <>
            <div className="h-4 w-px bg-nova-border" />
            <nav aria-label="Breadcrumb" className="text-sm text-nova-text-secondary">
              {breadcrumb.map((seg, i) => (
                <span key={i}>
                  {i > 0 && <span aria-hidden="true" className="mx-1.5 text-nova-text-muted">/</span>}
                  {seg.href ? (
                    <Link href={seg.href} className="hover:text-nova-text transition-colors">
                      {seg.label}
                    </Link>
                  ) : (
                    <span className="text-nova-text">{seg.label}</span>
                  )}
                </span>
              ))}
            </nav>
          </>
        )}
      </div>

      {/* ── Right: nav + account menu ──────────────────────── */}
      <HeaderNav isAdmin={isAdmin} />
    </header>
  )
}
