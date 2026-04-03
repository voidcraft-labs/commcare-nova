/**
 * Loading skeleton for the admin user detail page.
 *
 * Shows during client-side navigation while the RSC payload is in flight.
 * Mirrors the page shell: in-page breadcrumb, profile card, usage table,
 * and project list. The global header is rendered by the root layout.
 * Individual skeleton components are exported for reuse as Suspense fallbacks.
 */
import { Skeleton } from '@/components/ui/Skeleton'

// ── Section Skeletons (reused by page Suspense boundaries) ───────────

/** Profile card skeleton — matches avatar + name + email + dates + badge. */
export function ProfileSkeleton() {
  return (
    <div className="bg-nova-deep border border-nova-border rounded-xl p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Skeleton variant="circle" className="w-12 h-12" />
          <div>
            <Skeleton className="w-32 h-5" />
            <Skeleton className="w-48 h-4 mt-1.5" />
            <Skeleton className="w-56 h-3 mt-2" />
          </div>
        </div>
        <Skeleton className="w-14 h-5 rounded-md" />
      </div>
    </div>
  )
}

/** Usage history skeleton — section heading + table with 3 rows. */
export function UsageSkeleton() {
  return (
    <section>
      <Skeleton className="w-32 h-5 mb-4" />
      <div className="rounded-xl border border-nova-border overflow-hidden">
        {/* Header row */}
        <div className="flex gap-8 px-4 py-3 border-b border-nova-border bg-nova-deep/50">
          {[48, 72, 96, 40].map((w, i) => (
            <Skeleton key={i} className="h-3" style={{ width: w }} />
          ))}
        </div>
        {/* Body rows */}
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex gap-8 px-4 py-3 border-b border-nova-border/50">
            <Skeleton className="w-20 h-4" />
            <Skeleton className="w-8 h-4" />
            <Skeleton className="w-24 h-4" />
            <Skeleton className="w-12 h-4" />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Project list skeleton — section heading + 3 project card placeholders. */
export function ProjectsSkeleton() {
  return (
    <section>
      <Skeleton className="w-24 h-5 mb-4" />
      <div className="grid gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="p-4 bg-nova-surface border border-nova-border rounded-lg flex items-center justify-between"
          >
            <div>
              <Skeleton className="w-36 h-5" />
              <div className="flex items-center gap-3 mt-2">
                <Skeleton className="w-20 h-3.5" />
                <Skeleton className="w-28 h-3.5" />
              </div>
            </div>
            <Skeleton className="w-16 h-6 rounded-md" />
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Full Page Skeleton ───────────────────────────────────────────────

export default function AdminUserDetailLoading() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
      {/* Breadcrumb skeleton */}
      <div className="flex items-center gap-2">
        <Skeleton className="w-16 h-4" />
        <Skeleton className="w-2 h-4" />
        <Skeleton className="w-40 h-4" />
      </div>

      <ProfileSkeleton />
      <UsageSkeleton />
      <ProjectsSkeleton />
    </main>
  )
}
