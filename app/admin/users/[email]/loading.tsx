/**
 * Loading skeleton for the admin user detail page.
 *
 * Shows during client-side navigation while the RSC payload is in flight.
 * Mirrors the page shell: in-page breadcrumb, profile card, usage table,
 * and project list. The global header is rendered by the root layout.
 * Individual skeleton components are exported for reuse as Suspense fallbacks.
 */
import { Skeleton } from '@/components/ui/Skeleton'

/** Header column widths for the usage table skeleton (date, count, model, cost). */
const USAGE_HEADER_WIDTHS = [
  { id: 'date', width: 48 },
  { id: 'count', width: 72 },
  { id: 'model', width: 96 },
  { id: 'cost', width: 40 },
] as const

/** Stable keys for usage table body rows. */
const USAGE_ROW_KEYS = ['usage-a', 'usage-b', 'usage-c'] as const

/** Stable keys for project card placeholders. */
const PROJECT_CARD_KEYS = ['project-a', 'project-b', 'project-c'] as const

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
        {/* Header row — widths mirror real usage table columns */}
        <div className="flex gap-8 px-4 py-3 border-b border-nova-border bg-nova-deep/50">
          {USAGE_HEADER_WIDTHS.map(({ id, width }) => (
            <Skeleton key={id} className="h-3" style={{ width }} />
          ))}
        </div>
        {/* Body rows */}
        {USAGE_ROW_KEYS.map((key) => (
          <div key={key} className="flex gap-8 px-4 py-3 border-b border-nova-border/50">
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
        {PROJECT_CARD_KEYS.map((key) => (
          <div
            key={key}
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
