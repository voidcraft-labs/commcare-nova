/**
 * Root loading skeleton — shown during client-side navigation while the
 * target route's server component resolves.
 *
 * This is the root layout's loading boundary, so it fires for navigation
 * to ANY child route (not just `/`). It must be route-neutral — page-specific
 * skeletons belong in their own Suspense boundaries (e.g. the `<Suspense
 * fallback={<AppListSkeleton />}>` inside `app/page.tsx`).
 */
import { Logo } from "@/components/ui/Logo";

export default function RootLoading() {
	return (
		<div className="h-full flex items-center justify-center">
			<div className="animate-pulse">
				<Logo size="md" />
			</div>
		</div>
	);
}
