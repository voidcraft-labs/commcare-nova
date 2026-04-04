/**
 * Loading skeleton for the builds page.
 *
 * Shows during client-side navigation while the RSC payload is in flight.
 * Mirrors the page shell structure: heading row + app card grid.
 * The global header is rendered by the root layout (no duplication needed here).
 * `AppListSkeleton` is exported for reuse as a Suspense fallback in the page.
 */
import { Skeleton } from "@/components/ui/Skeleton";

/** Stable keys for app card skeleton placeholders. */
const APP_CARD_KEYS = ["app-a", "app-b", "app-c", "app-d"] as const;

// ── Shared Skeleton (reused by page Suspense boundary) ───────────────

/** Skeleton for the app card grid — matches `AppCard` layout. */
export function AppListSkeleton() {
	return (
		<div className="grid gap-3">
			{APP_CARD_KEYS.map((key) => (
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
	);
}

// ── Full Page Skeleton ───────────────────────────────────────────────

export default function BuildsLoading() {
	return (
		<main className="max-w-4xl mx-auto px-6 py-12">
			{/* Heading row: title + "New Build" button */}
			<div className="flex items-center justify-between mb-8">
				<Skeleton className="w-40 h-7" />
				<Skeleton className="w-24 h-8 rounded-lg" />
			</div>

			<AppListSkeleton />
		</main>
	);
}
