/**
 * Home app list — Server Component shell. Fetches the user's active
 * and recently-deleted apps in parallel and hands both arrays to the
 * client island that owns the active/deleted view toggle. The
 * orchestration is deliberately flat: this file knows the user's
 * apps, the page header, and the existence of the body component —
 * nothing about per-card state, action wiring, or filtering.
 *
 * Wrapped in a Suspense boundary by the page so the shell streams
 * before the Postgres queries resolve. Both queries read different
 * ends of the same table (live rows vs. `deleted_at`-flagged
 * rows) so they have no read-after-write dependency and run in
 * parallel.
 */

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { Button } from "@/components/shadcn/button";
import { listApps, listDeletedApps } from "@/lib/db/apps";
import { listUserProjects } from "@/lib/projects/membership";
import { canManageAppPlacement } from "@/lib/projects/moveTargets";
import { AppListBody } from "./app-list-body";

interface AppListProps {
	/** Active Project id (Better Auth organizationId) — the tenancy scope. */
	projectId: string;
	/** Signed-in user — resolves their role in the active Project. */
	userId: string;
}

/**
 * First-page size. The web surface is non-paginated today — a single
 * card grid up to this many rows. The same number is reused for the
 * recently-deleted list, which is naturally bounded by the 30-day
 * retention window and rarely binds.
 */
const PAGE_SIZE = 50;

export async function AppList({ projectId, userId }: AppListProps) {
	const [activeRes, deletedRes, projects] = await Promise.all([
		listApps(projectId, { limit: PAGE_SIZE, sort: "updated_desc" }),
		listDeletedApps(projectId, { limit: PAGE_SIZE }),
		listUserProjects(userId),
	]);

	/* Admins/owners retain the old placement affordance while cross-Project moves
	 * are temporarily unavailable. It is now an informational popover, not a target
	 * picker, so the page deliberately performs no destination or owner-membership
	 * reads that could imply an available move. */
	const active = projects.find((p) => p.id === projectId);
	const showProjectMoveInfo = Boolean(
		active && canManageAppPlacement(active.role),
	);

	return (
		<>
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold">Your Apps</h1>
				<Button
					render={<Link href="/build/new" />}
					nativeButton={false}
					size="lg"
					className="shadow-[var(--nova-glow-violet)]"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					New App
				</Button>
			</div>

			<AppListBody
				active={activeRes.apps}
				deleted={deletedRes.apps}
				showProjectMoveInfo={showProjectMoveInfo}
			/>
		</>
	);
}
