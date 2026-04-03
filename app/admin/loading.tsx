/**
 * Loading skeleton for the admin dashboard.
 *
 * Shows during client-side navigation while the RSC payload is in flight.
 * Mirrors the page shell: title, stat cards, and user table.
 * The global header is rendered by the root layout (no duplication needed here).
 * `AdminContentSkeleton` is exported for reuse as a Suspense fallback in the page.
 */
import { Skeleton } from '@/components/ui/Skeleton'

// ── Shared Skeleton (reused by page Suspense boundary) ───────────────

/** Skeleton for the stat cards + user table — matches real content layout. */
export function AdminContentSkeleton() {
  return (
    <div className="space-y-8">
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-nova-deep border border-nova-border rounded-xl p-6">
            <Skeleton className="w-20 h-3" />
            <Skeleton className="w-24 h-9 mt-2" />
            {i > 0 && <Skeleton className="w-16 h-3 mt-1.5" />}
          </div>
        ))}
      </div>

      {/* User table */}
      <div className="space-y-6">
        {/* Search input */}
        <div className="w-full h-10 bg-nova-deep border border-nova-border rounded-lg" />

        {/* Table */}
        <div className="rounded-xl border border-nova-border overflow-hidden">
          {/* Header row */}
          <div className="flex gap-4 px-4 py-3 border-b border-nova-border bg-nova-deep/50">
            {[56, 80, 40, 48, 64, 48, 64].map((w, i) => (
              <Skeleton key={i} className="h-3" style={{ width: w }} />
            ))}
          </div>
          {/* Body rows */}
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-nova-border/50">
              <div className="flex items-center gap-2.5">
                <Skeleton variant="circle" className="w-6 h-6" />
                <Skeleton className="w-24 h-4" />
              </div>
              <Skeleton className="w-36 h-4" />
              <Skeleton className="w-12 h-5 rounded-md" />
              <Skeleton className="w-8 h-4" />
              <Skeleton className="w-8 h-4" />
              <Skeleton className="w-12 h-4" />
              <Skeleton className="w-16 h-4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Full Page Skeleton ───────────────────────────────────────────────

export default function AdminLoading() {
  return (
    <main className="max-w-6xl mx-auto px-6 py-12">
      <Skeleton className="w-48 h-7 mb-8" />
      <AdminContentSkeleton />
    </main>
  )
}
