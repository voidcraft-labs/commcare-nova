'use client'
import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciArrowLeftSm from '@iconify-icons/ci/arrow-left-sm'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ProjectCard } from '@/components/ui/ProjectCard'
import { useAuth } from '@/hooks/useAuth'
import { useReplay } from '@/hooks/useReplay'
import type { AdminUserDetailResponse, UsagePeriod } from '@/lib/types/admin'
import { formatRelativeDate, formatCurrency, formatTokenCount, formatPeriodLabel } from '@/lib/utils/format'

// ── Page ──────────────────────────────────────────────────────────

export default function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ email: string }>
}) {
  const { email: rawEmail } = use(params)
  const email = decodeURIComponent(rawEmail)
  const router = useRouter()
  const { isAdmin, isPending: adminLoading } = useAuth()
  const encodedEmail = encodeURIComponent(email)
  const buildUrl = (id: string) => `/api/admin/users/${encodedEmail}/projects/${id}/logs`
  const { handleReplay, replayingId, replayError } = useReplay({ buildUrl })
  const [data, setData] = useState<AdminUserDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  /* Redirect non-admins */
  useEffect(() => {
    if (adminLoading) return
    if (!isAdmin) router.replace('/builds')
  }, [adminLoading, isAdmin, router])

  /* Fetch user detail */
  useEffect(() => {
    if (!isAdmin) return
    fetch(`/api/admin/users/${encodedEmail}`)
      .then(res => {
        if (res.status === 404) throw new Error('User not found')
        if (!res.ok) throw new Error('Failed to load user data')
        return res.json() as Promise<AdminUserDetailResponse>
      })
      .then(result => {
        setData(result)
        setLoading(false)
      })
      .catch(err => {
        console.error('[admin/user] fetch failed:', err)
        setFetchError(err.message || 'Failed to load user data.')
        setLoading(false)
      })
  }, [isAdmin, encodedEmail])

  const error = fetchError || replayError

  if (adminLoading || !isAdmin) return null

  return (
    <div className="min-h-screen bg-nova-void">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="border-b border-nova-border px-6 py-4 flex items-center gap-4">
        <Link
          href="/admin"
          className="p-1 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
          title="Back to Admin Dashboard"
        >
          <Icon icon={ciArrowLeftSm} width="20" height="20" />
        </Link>
        <Link href="/">
          <Logo size="sm" />
        </Link>
        <div className="h-4 w-px bg-nova-border" />
        <nav className="text-sm text-nova-text-secondary">
          <Link href="/admin" className="hover:text-nova-text transition-colors">Admin</Link>
          <span className="mx-1.5 text-nova-text-muted">/</span>
          <span className="text-nova-text">{email}</span>
        </nav>
      </header>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="max-w-4xl mx-auto px-6 py-10">
        {/* Error state */}
        {error && (
          <div className="text-center py-12" role="alert">
            <p className="text-nova-rose mb-4">{error}</p>
            <Button onClick={() => window.location.reload()} size="sm" variant="secondary">
              Retry
            </Button>
          </div>
        )}

        {/* Loading state */}
        {loading && !error && (
          <div className="space-y-6 animate-pulse">
            <div className="bg-nova-deep border border-nova-border rounded-xl p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-nova-border" />
                <div className="space-y-2">
                  <div className="h-5 w-40 bg-nova-border rounded" />
                  <div className="h-3 w-56 bg-nova-border/50 rounded" />
                </div>
              </div>
            </div>
            {[0, 1, 2].map(i => (
              <div key={i} className="h-16 bg-nova-surface border border-nova-border rounded-lg" />
            ))}
          </div>
        )}

        {/* User detail */}
        {!loading && !error && data && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-8"
          >
            {/* ── Profile Card ──────────────────────────────── */}
            <div className="bg-nova-deep border border-nova-border rounded-xl p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {data.user.image ? (
                    <img
                      src={data.user.image}
                      alt=""
                      className="w-12 h-12 rounded-full border border-nova-border"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-nova-surface border border-nova-border flex items-center justify-center text-lg text-nova-text-secondary">
                      {data.user.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <h2 className="text-lg font-display font-semibold">{data.user.name}</h2>
                    <p className="text-sm text-nova-text-secondary">{data.user.email}</p>
                    <p className="text-xs text-nova-text-muted mt-1">
                      Joined {new Date(data.user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {' \u00b7 '}
                      Active {formatRelativeDate(new Date(data.user.last_active_at))}
                    </p>
                  </div>
                </div>
                <Badge variant={data.user.role === 'admin' ? 'violet' : 'muted'}>
                  {data.user.role}
                </Badge>
              </div>
            </div>

            {/* ── Usage History ─────────────────────────────── */}
            <section>
              <h3 className="text-lg font-display font-semibold mb-4">Usage History</h3>
              {data.usage.length === 0 ? (
                <p className="text-sm text-nova-text-secondary">No usage recorded yet.</p>
              ) : (
                <div className="rounded-xl border border-nova-border overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-nova-border bg-nova-deep/50">
                        <th scope="col" className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary">Period</th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary">Generations</th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary">Tokens (in / out)</th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.usage.map((period: UsagePeriod) => (
                        <tr key={period.period} className="border-b border-nova-border/50">
                          <td className="px-4 py-3 text-sm font-medium">{formatPeriodLabel(period.period)}</td>
                          <td className="px-4 py-3 text-sm tabular-nums">{period.request_count}</td>
                          <td className="px-4 py-3 text-sm text-nova-text-secondary tabular-nums">
                            {formatTokenCount(period.input_tokens)} / {formatTokenCount(period.output_tokens)}
                          </td>
                          <td className="px-4 py-3 text-sm tabular-nums">{formatCurrency(period.cost_estimate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ── Projects ─────────────────────────────────── */}
            <section>
              <h3 className="text-lg font-display font-semibold mb-4">
                Projects ({data.projects.length})
              </h3>
              {data.projects.length === 0 ? (
                <p className="text-sm text-nova-text-secondary">No projects yet.</p>
              ) : (
                <div className="grid gap-3">
                  {data.projects.map((project, i) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      index={i}
                      onReplay={handleReplay}
                      replayingId={replayingId}
                    />
                  ))}
                </div>
              )}
            </section>
          </motion.div>
        )}
      </main>
    </div>
  )
}
