/**
 * Skeleton components for the admin dashboard.
 *
 * Used as Suspense fallbacks in admin pages. Extracted from `loading.tsx`
 * because Next.js `loading.tsx` files trigger prerender attempts on routes
 * whose layouts use `headers()` — a known framework bug. Using explicit
 * `<Suspense fallback={...}>` in each page avoids the issue entirely.
 */
import { Skeleton } from "@/components/ui/Skeleton";

/** Header column widths matching the real UserTable columns (user, email, role, apps, generations, spend, last active). */
const ADMIN_TABLE_HEADER_WIDTHS = [
	{ id: "user", width: 56 },
	{ id: "email", width: 80 },
	{ id: "role", width: 40 },
	{ id: "apps", width: 48 },
	{ id: "generations", width: 64 },
	{ id: "spend", width: 48 },
	{ id: "last-active", width: 64 },
] as const;

/** Stable keys for skeleton body rows — avoids array index keys. */
const SKELETON_ROW_KEYS = [
	"row-a",
	"row-b",
	"row-c",
	"row-d",
	"row-e",
	"row-f",
] as const;

// ── Shared Skeleton (reused by page Suspense boundary) ───────────────

/** Skeleton for the stat cards + user table — matches real content layout. */
export function AdminContentSkeleton() {
	return (
		<div className="space-y-8">
			{/* Stat cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				{/* Stat card skeletons — first card is the primary count (no subtitle),
            remaining two include a subtitle line to match the real layout. */}
				<div className="bg-nova-deep border border-nova-border rounded-xl p-6">
					<Skeleton className="w-20 h-3" />
					<Skeleton className="w-24 h-9 mt-2" />
				</div>
				<div className="bg-nova-deep border border-nova-border rounded-xl p-6">
					<Skeleton className="w-20 h-3" />
					<Skeleton className="w-24 h-9 mt-2" />
					<Skeleton className="w-16 h-3 mt-1.5" />
				</div>
				<div className="bg-nova-deep border border-nova-border rounded-xl p-6">
					<Skeleton className="w-20 h-3" />
					<Skeleton className="w-24 h-9 mt-2" />
					<Skeleton className="w-16 h-3 mt-1.5" />
				</div>
			</div>

			{/* User table */}
			<div className="space-y-6">
				{/* Search input */}
				<div className="w-full h-10 bg-nova-deep border border-nova-border rounded-lg" />

				{/* Table */}
				<div className="rounded-xl border border-nova-border overflow-hidden">
					{/* Header row — widths mirror the 7 real table columns */}
					<div className="flex gap-4 px-4 py-3 border-b border-nova-border bg-nova-deep/50">
						{ADMIN_TABLE_HEADER_WIDTHS.map(({ id, width }) => (
							<Skeleton key={id} className="h-3" style={{ width }} />
						))}
					</div>
					{/* Body rows */}
					{SKELETON_ROW_KEYS.map((key) => (
						<div
							key={key}
							className="flex items-center gap-4 px-4 py-3 border-b border-nova-border/50"
						>
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
	);
}

/** Full-page skeleton — title + content. Used by navigation-level Suspense. */
export function AdminPageSkeleton() {
	return (
		<main className="max-w-6xl mx-auto px-6 py-12">
			<Skeleton className="w-48 h-7 mb-8" />
			<AdminContentSkeleton />
		</main>
	);
}
