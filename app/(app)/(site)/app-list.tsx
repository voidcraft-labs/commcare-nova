/**
 * Home app list — Server Component shell. Fetches the user's active
 * and recently-deleted apps in parallel and hands both arrays to the
 * client island that owns the active/deleted view toggle. The
 * orchestration is deliberately flat: this file knows the user's
 * apps, the page header, and the existence of the body component —
 * nothing about per-card state, action wiring, or filtering.
 *
 * Wrapped in a Suspense boundary by the page so the shell streams
 * before the Firestore queries resolve. Both queries read different
 * ends of the same collection (live rows vs. `deleted_at`-flagged
 * rows) so they have no read-after-write dependency and run in
 * parallel.
 */

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { listApps, listDeletedApps } from "@/lib/db/apps";
import { AppListBody } from "./app-list-body";

interface AppListProps {
	/** Owner ID (Better Auth user ID). */
	userId: string;
	/** Whether to show admin-only replay buttons on active cards. */
	isAdmin: boolean;
}

/**
 * First-page size. The web surface is non-paginated today — a single
 * card grid up to this many rows. The same number is reused for the
 * recently-deleted list, which is naturally bounded by the 30-day
 * retention window and rarely binds.
 */
const PAGE_SIZE = 50;

export async function AppList({ userId, isAdmin }: AppListProps) {
	const [activeRes, deletedRes] = await Promise.all([
		listApps(userId, { limit: PAGE_SIZE, sort: "updated_desc" }),
		listDeletedApps(userId, { limit: PAGE_SIZE }),
	]);

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

			<AppListBody
				active={activeRes.apps}
				deleted={deletedRes.apps}
				showReplay={isAdmin}
			/>
		</>
	);
}
