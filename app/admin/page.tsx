import { PageHeader } from '@/components/ui/PageHeader'
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
      <PageHeader isAdmin />

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
