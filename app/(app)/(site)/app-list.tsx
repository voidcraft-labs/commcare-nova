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
import { roleIsOwner } from "@/lib/auth/projectRoles";
import { listApps, listDeletedApps } from "@/lib/db/apps";
import { listUserProjects, projectOwnerId } from "@/lib/projects/membership";
import {
	canMoveAppsFrom,
	eligibleMoveTargets,
	type MoveTarget,
} from "@/lib/projects/moveTargets";
import { AppListBody } from "./app-list-body";

interface AppListProps {
	/** Active Project id (Better Auth organizationId) — the tenancy scope. */
	projectId: string;
	/** Signed-in user — resolves which Projects an app may move into. */
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

export async function AppList({ projectId, userId, isAdmin }: AppListProps) {
	const [activeRes, deletedRes, projects] = await Promise.all([
		listApps(projectId, { limit: PAGE_SIZE, sort: "updated_desc" }),
		listDeletedApps(projectId, { limit: PAGE_SIZE }),
		listUserProjects(userId),
	]);

	/* `canMove` — whether the user is admin/owner of the active Project (the bar
	 * to move an app out of it); it drives whether the move menu appears at all
	 * (even with no destinations, the menu shows an empty-state hint so a user with
	 * only their personal Project can discover the path). `moveTargets` — the
	 * eligible destinations: the admin/owner candidate list, refined by the move's
	 * owner-protection rule (mirrored from the Server Action) when the caller isn't
	 * the source owner — so the picker never offers a destination the move refuses. */
	const active = projects.find((p) => p.id === projectId);
	const canMove = Boolean(active && canMoveAppsFrom(active.role));
	let moveTargets: MoveTarget[] = [];
	if (active && canMove) {
		const candidates = eligibleMoveTargets(projects, projectId);
		if (roleIsOwner(active.role)) {
			moveTargets = candidates;
		} else {
			// Non-owner admin: keep only destinations the source Project's owner is
			// also a member of (the owner must not lose access). One indexed read of
			// the owner's Projects (cached), intersected in memory — not a query per
			// candidate. Only on the less-common admin-moving-a-shared-app path.
			const ownerId = await projectOwnerId(projectId);
			if (!ownerId) {
				moveTargets = candidates;
			} else {
				const ownerProjectIds = new Set(
					(await listUserProjects(ownerId)).map((p) => p.id),
				);
				moveTargets = candidates.filter((c) => ownerProjectIds.has(c.id));
			}
		}
	}

	return (
		<>
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold">Your Apps</h1>
				<Link
					href="/build/new"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-nova-action text-white border border-transparent hover:bg-nova-action-hover shadow-[var(--nova-glow-violet)] transition-all duration-200"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					New App
				</Link>
			</div>

			<AppListBody
				active={activeRes.apps}
				deleted={deletedRes.apps}
				showReplay={isAdmin}
				canMove={canMove}
				moveTargets={moveTargets}
			/>
		</>
	);
}
