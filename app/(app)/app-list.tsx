/**
 * Async server component for the app list.
 *
 * Separated from the page so it can be wrapped in a Suspense boundary —
 * the page shell streams immediately while this component resolves the
 * Firestore query. Only rendered when `userHasApps` returns true (checked
 * at the page level before the Suspense boundary).
 */

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { AppCardList } from "@/components/ui/AppCardList";
import { listApps } from "@/lib/db/apps";

interface AppListProps {
	/** Owner ID (Better Auth user ID) — used to query apps by owner. */
	userId: string;
	/** Whether to show replay buttons (admin-only feature). */
	isAdmin: boolean;
}

/**
 * First-page size for the web card grid.
 *
 * The web surface is non-paginated today — it renders a single card grid
 * of up to this many apps. Picked to match the previous hard-coded default
 * in `listApps` so behavior is unchanged after the signature refactor.
 * When the web UI grows a "show more" affordance, consume `nextCursor`
 * here too instead of widening this number.
 */
const WEB_LIST_PAGE_SIZE = 50;

export async function AppList({ userId, isAdmin }: AppListProps) {
	const { apps } = await listApps(userId, {
		limit: WEB_LIST_PAGE_SIZE,
		sort: "updated_desc",
	});

	return (
		<>
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold">Your Apps</h1>
				<Link
					href="/build/new"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					New App
				</Link>
			</div>

			<AppCardList apps={apps} linkToApps showReplay={isAdmin} />
		</>
	);
}
