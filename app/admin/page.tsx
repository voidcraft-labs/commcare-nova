'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import tablerChevronUp from '@iconify-icons/tabler/chevron-up'
import tablerChevronDown from '@iconify-icons/tabler/chevron-down'
import tablerArrowsSort from '@iconify-icons/tabler/arrows-sort'
import Link from 'next/link'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type SortingState,
  type ColumnDef,
} from '@tanstack/react-table'
import { Logo } from '@/components/ui/Logo'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import type { AdminUserRow, AdminStats, AdminUsersResponse } from '@/lib/types/admin'
import { formatRelativeDate, formatCurrency } from '@/lib/utils/format'

// ── Table Column Definitions ──────────────────────────────────────

const columns: ColumnDef<AdminUserRow>[] = [
  {
    accessorKey: 'name',
    header: 'User',
    cell: ({ row }) => (
      <div className="flex items-center gap-2.5">
        {row.original.image ? (
          <img
            src={row.original.image}
            alt=""
            className="w-6 h-6 rounded-full border border-nova-border"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-nova-surface border border-nova-border flex items-center justify-center text-[10px] text-nova-text-secondary">
            {row.original.name.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="font-medium">{row.original.name}</span>
      </div>
    ),
  },
  {
    accessorKey: 'email',
    header: 'Email',
    cell: ({ getValue }) => (
      <span className="text-nova-text-secondary">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'role',
    header: 'Role',
    cell: ({ getValue }) => {
      const role = getValue<'user' | 'admin'>()
      return <Badge variant={role === 'admin' ? 'violet' : 'muted'}>{role}</Badge>
    },
  },
  {
    accessorKey: 'project_count',
    header: 'Projects',
    cell: ({ getValue }) => (
      <span className="tabular-nums">{getValue<number>()}</span>
    ),
  },
  {
    accessorKey: 'generations',
    header: 'Generations',
    cell: ({ getValue }) => (
      <span className="tabular-nums">{getValue<number>()}</span>
    ),
  },
  {
    accessorKey: 'cost',
    header: 'Spend',
    cell: ({ getValue }) => (
      <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
    ),
  },
  {
    accessorKey: 'last_active_at',
    header: 'Last Active',
    cell: ({ getValue }) => formatRelativeDate(new Date(getValue<string>())),
    sortingFn: 'datetime',
  },
]

// ── Stat Card ─────────────────────────────────────────────────────

function StatCard({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="bg-nova-deep border border-nova-border rounded-xl p-6">
      <p className="text-xs font-display font-semibold uppercase tracking-wide text-nova-text-secondary mb-1">
        {label}
      </p>
      <p className="text-3xl font-display font-semibold text-nova-text">{value}</p>
      {subtitle && (
        <p className="text-xs text-nova-text-muted mt-1">{subtitle}</p>
      )}
    </div>
  )
}

// ── Sort Indicator ────────────────────────────────────────────────

function SortIndicator({ direction }: { direction: false | 'asc' | 'desc' }) {
  if (direction === 'asc') return <Icon icon={tablerChevronUp} width="14" height="14" className="text-nova-violet-bright" />
  if (direction === 'desc') return <Icon icon={tablerChevronDown} width="14" height="14" className="text-nova-violet-bright" />
  return <Icon icon={tablerArrowsSort} width="14" height="14" className="opacity-30" />
}

// ── Page ──────────────────────────────────────────────────────────

export default function AdminDashboardPage() {
  const router = useRouter()
  const { isAdmin, isPending: adminLoading } = useAuth()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'last_active_at', desc: true },
  ])
  const [globalFilter, setGlobalFilter] = useState('')

  /* Redirect non-admins */
  useEffect(() => {
    if (adminLoading) return
    if (!isAdmin) router.replace('/builds')
  }, [adminLoading, isAdmin, router])

  /* Fetch admin data */
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/admin/users')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load admin data')
        return res.json() as Promise<AdminUsersResponse>
      })
      .then(data => {
        setUsers(data.users)
        setStats(data.stats)
        setLoading(false)
      })
      .catch(err => {
        console.error('[admin] fetch failed:', err)
        setError('Failed to load admin data. Please try again.')
        setLoading(false)
      })
  }, [isAdmin])

  const table = useReactTable({
    data: users,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  if (adminLoading || !isAdmin) return null

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
          <div className="space-y-6">
            {/* Stat card skeletons */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-nova-deep border border-nova-border rounded-xl p-6 animate-pulse">
                  <div className="h-3 w-24 bg-nova-border rounded mb-3" />
                  <div className="h-8 w-16 bg-nova-border rounded" />
                </div>
              ))}
            </div>
            {/* Table skeleton */}
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="h-12 bg-nova-surface border border-nova-border rounded-lg animate-pulse" />
              ))}
            </div>
          </div>
        )}

        {/* Stats + table */}
        {!loading && !error && stats && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-8"
          >
            {/* Stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard label="Total Users" value={String(stats.totalUsers)} />
              <StatCard label="Generations" value={String(stats.totalGenerations)} subtitle="this month" />
              <StatCard label="Total Spend" value={formatCurrency(stats.totalSpend)} subtitle="this month" />
            </div>

            {/* Search */}
            <input
              type="text"
              value={globalFilter}
              onChange={e => setGlobalFilter(e.target.value)}
              placeholder="Search users..."
              autoComplete="off"
              data-1p-ignore
              className="w-full px-4 py-2.5 text-sm bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all"
            />

            {/* User table */}
            <div className="rounded-xl border border-nova-border overflow-x-auto">
              <table className="w-full">
                <thead>
                  {table.getHeaderGroups().map(headerGroup => (
                    <tr key={headerGroup.id} className="border-b border-nova-border bg-nova-deep/50">
                      {headerGroup.headers.map(header => (
                        <th
                          scope="col"
                          key={header.id}
                          onClick={header.column.getToggleSortingHandler()}
                          className={`
                            px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide
                            ${header.column.getIsSorted() ? 'text-nova-violet-bright' : 'text-nova-text-secondary'}
                            ${header.column.getCanSort() ? 'cursor-pointer select-none hover:text-nova-text' : ''}
                          `}
                        >
                          <div className="flex items-center gap-1">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getCanSort() && (
                              <SortIndicator direction={header.column.getIsSorted()} />
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map(row => (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      role="link"
                      onClick={() => router.push(`/admin/users/${encodeURIComponent(row.original.email)}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          router.push(`/admin/users/${encodeURIComponent(row.original.email)}`)
                        }
                      }}
                      className="border-b border-nova-border/50 hover:bg-nova-surface/50 transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-nova-violet/50"
                    >
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-4 py-3 text-sm">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {table.getRowModel().rows.length === 0 && (
                <div className="text-center py-12 text-nova-text-secondary">
                  {globalFilter ? 'No users match your search' : 'No users found'}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </main>
    </div>
  )
}
