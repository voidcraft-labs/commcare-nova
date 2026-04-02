import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Icon } from '@iconify/react/offline'
import ciArrowLeftSm from '@iconify-icons/ci/arrow-left-sm'
import { Logo } from '@/components/ui/Logo'
import { Badge } from '@/components/ui/Badge'
import { getAdminUserDetail } from '@/lib/db/admin'
import { formatRelativeDate, formatCurrency, formatTokenCount, formatPeriodLabel } from '@/lib/utils/format'
import type { UsagePeriod } from '@/lib/types/admin'
import { ReplayableProjectList } from '@/components/ui/ReplayableProjectList'

/**
 * Admin user detail — server-rendered profile, usage table, and project list.
 *
 * Auth is handled by the admin layout (requireAdminAccess). The entire page
 * structure — header, profile card, usage history table — renders on the server
 * with zero client JS. Only the UserProjects component (replay functionality)
 * ships as a client component.
 */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ email: string }>
}) {
  const { email: rawEmail } = await params
  const email = decodeURIComponent(rawEmail)
  const encodedEmail = encodeURIComponent(email)

  const data = await getAdminUserDetail(email)
  if (!data) notFound()

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
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
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
          <ReplayableProjectList
            projects={data.projects}
            logsUrlPrefix={`/api/admin/users/${encodedEmail}/projects`}
            emptyState={<p className="text-sm text-nova-text-secondary">No projects yet.</p>}
          />
        </section>
      </main>
    </div>
  )
}
