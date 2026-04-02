import Link from 'next/link'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import { Logo } from '@/components/ui/Logo'
import { getAdminUsersWithStats } from '@/lib/db/admin'
import { formatCurrency } from '@/lib/utils/format'
import { StatCard } from './stat-card'
import { UserTable } from './user-table'

/**
 * Admin dashboard — server-rendered structure with interactive table leaf.
 *
 * Auth is handled by the admin layout (requireAdminAccess). Data is fetched
 * server-side. The header, stat cards, and heading render on the server with
 * zero client JS. Only the UserTable (sorting, filtering, row navigation)
 * ships as a client component.
 */
export default async function AdminDashboardPage() {
  const { users, stats } = await getAdminUsersWithStats()

  return (
    <div className="min-h-screen bg-nova-void">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="border-b border-nova-border px-6 py-4 flex items-center justify-between">
        <Link href="/">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/builds"
            className="px-3 py-1.5 text-sm text-nova-text-secondary hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
          >
            Builds
          </Link>
          <Link
            href="/settings"
            className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
            title="Settings"
          >
            <Icon icon={ciSettings} width="18" height="18" />
          </Link>
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-display font-semibold mb-8">Admin Dashboard</h1>

        <div className="space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard label="Total Users" value={String(stats.totalUsers)} />
            <StatCard label="Generations" value={String(stats.totalGenerations)} subtitle="this month" />
            <StatCard label="Total Spend" value={formatCurrency(stats.totalSpend)} subtitle="this month" />
          </div>

          <UserTable users={users} />
        </div>
      </main>
    </div>
  )
}
