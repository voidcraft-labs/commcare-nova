/**
 * Account menu — avatar-triggered dropdown with profile, usage bar,
 * settings link, and sign-out.
 *
 * Two render modes based on auth state:
 * - **Authenticated**: circular avatar (or initials fallback) that opens
 *   a POPOVER_GLASS dropdown with profile info, monthly usage progress,
 *   a Settings navigation row, and a Sign Out action.
 * - **Not authenticated**: falls back to a settings gear icon linking
 *   to `/settings`, preserving BYOK access to pipeline configuration.
 *
 * Uses FloatingPortal so the dropdown escapes `overflow-hidden` ancestors
 * (e.g. the BuilderLayout header's height-collapse animation).
 *
 * Usage data is fetched eagerly on mount from `GET /api/user/usage`
 * so the dropdown opens instantly with no loading state.
 */

'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import ciLogout from '@iconify-icons/ci/log-out'
import Link from 'next/link'
import { useFloatingDropdown, DropdownPortal } from '@/hooks/useFloatingDropdown'
import { useAuth, type AuthUser } from '@/hooks/useAuth'
import { POPOVER_GLASS, NAV_ICON_CLASS } from '@/lib/styles'
import { formatCurrency } from '@/lib/utils/format'

/** Response shape from GET /api/user/usage. */
interface UsageData {
  cost_estimate: number
  request_count: number
  cap: number
  period: string
}

/**
 * Extract up to two initials from a display name.
 * Falls back to "?" if the name is empty.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return parts[0]?.[0]?.toUpperCase() ?? '?'
}

/**
 * Progress bar gradient — violet→cyan by default, shifts to amber→rose
 * when usage exceeds 80% of the cap to signal proximity to the limit.
 */
function getBarGradient(ratio: number): string {
  if (ratio > 0.8) return 'from-nova-amber to-nova-rose'
  return 'from-nova-violet to-nova-cyan'
}

// ── Avatar helper ──────────────────────────────────────────────────

/** Size presets for the avatar — trigger (28px) and profile (36px). */
const AVATAR_SIZES = {
  sm: { box: 'w-7 h-7', text: 'text-[10px]', border: '' },
  md: { box: 'w-9 h-9', text: 'text-xs', border: 'border border-white/[0.08] shrink-0' },
} as const

/**
 * User avatar with initials fallback. Renders a circular image when the
 * user has a Google profile photo, otherwise shows extracted initials
 * on a solid surface background.
 */
function UserAvatar({ user, size }: { user: AuthUser; size: keyof typeof AVATAR_SIZES }) {
  const s = AVATAR_SIZES[size]
  if (user.image) {
    return (
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        className={`${s.box} rounded-full ${s.border}`}
      />
    )
  }
  return (
    <span className={`${s.box} rounded-full bg-nova-surface ${s.text} font-semibold text-nova-text flex items-center justify-center ${s.border}`}>
      {getInitials(user.name)}
    </span>
  )
}

// ── AccountMenu ────────────────────────────────────────────────────

export function AccountMenu() {
  const router = useRouter()
  const { user, isAuthenticated, isPending, signOut } = useAuth()
  const [usage, setUsage] = useState<UsageData | null>(null)
  const dd = useFloatingDropdown<HTMLButtonElement>({ offset: 6 })

  /* Fetch usage data eagerly on mount so the dropdown opens without a loading state.
   * Cancelled flag prevents stale setState if the component unmounts mid-flight. */
  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    fetch('/api/user/usage')
      .then(res => res.ok ? res.json() as Promise<UsageData> : null)
      .then(data => { if (!cancelled && data) setUsage(data) })
      .catch(() => { /* Silent — usage display is best-effort */ })
    return () => { cancelled = true }
  }, [isAuthenticated])

  /* ── Loading placeholder while session check is in flight ────── */
  if (isPending) {
    return <div className="w-7 h-7 rounded-full bg-nova-surface animate-pulse" />
  }

  /* ── Unauthenticated fallback: plain settings link ────────────── */
  if (!isAuthenticated || !user) {
    return (
      <Link href="/settings" className={NAV_ICON_CLASS} title="Settings">
        <Icon icon={ciSettings} width="18" height="18" />
      </Link>
    )
  }

  const usageRatio = usage ? Math.min(usage.cost_estimate / usage.cap, 1) : 0

  return (
    <>
      {/* ── Trigger: avatar or initials ──────────────────────── */}
      <button
        ref={dd.triggerRef}
        onClick={dd.toggle}
        className="flex items-center justify-center w-7 h-7 rounded-full cursor-pointer transition-all duration-150 ring-1 ring-transparent hover:ring-nova-border-bright focus-visible:ring-nova-violet outline-none"
        title="Account"
      >
        <UserAvatar user={user} size="sm" />
      </button>

      {/* ── Dropdown (portal) ────────────────────────────────── */}
      <DropdownPortal dropdown={dd}>
        <div className={`${POPOVER_GLASS} w-64 overflow-hidden`}>
          {/* ── Profile ────────────────────────────────────── */}
          <div className="px-4 pt-4 pb-3 flex items-center gap-3">
            <UserAvatar user={user} size="md" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-nova-text truncate">{user.name}</p>
              <p className="text-xs text-nova-text-muted truncate">{user.email}</p>
            </div>
          </div>

          {/* ── Usage bar ──────────────────────────────────── */}
          {usage && (
            <div className="px-4 pb-3">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[11px] text-nova-text-muted">Usage this month</span>
                <span className="text-[11px] text-nova-text-secondary">
                  {formatCurrency(usage.cost_estimate)} / {formatCurrency(usage.cap)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${getBarGradient(usageRatio)} transition-all duration-500`}
                  style={{ width: `${Math.max(usageRatio * 100, 1)}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Divider ────────────────────────────────────── */}
          <div className="border-t border-white/[0.06]" />

          {/* ── Menu rows ──────────────────────────────────── */}
          <div>
            <button
              onClick={() => { router.push('/settings'); dd.close() }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Icon icon={ciSettings} width="16" height="16" className="text-nova-text-muted" />
              Settings
            </button>
            <button
              onClick={() => { signOut(); dd.close() }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer rounded-b-xl"
            >
              <Icon icon={ciLogout} width="16" height="16" className="text-nova-text-muted" />
              Sign out
            </button>
          </div>
        </div>
      </DropdownPortal>
    </>
  )
}
