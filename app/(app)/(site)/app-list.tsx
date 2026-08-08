/**
 * Home app list: Server Component shell. Fetches the user's active
 * and recently-deleted apps in parallel and hands both arrays to the
 * client island that owns the active/deleted view toggle. The
 * orchestration is deliberately flat: this file knows the user's
 * apps, the page header, and the existence of the body component:
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
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { listApps, listDeletedApps } from "@/lib/db/apps";
import { listDesignsInProgress } from "@/lib/db/designInProgress";
import { listUserProjects } from "@/lib/projects/membership";
import { canManageAppPlacement } from "@/lib/projects/moveTargets";
import { AppListBody } from "./app-list-body";
import { DesignsInProgress } from "./designs-in-progress";
import { RefreshStaleAppList } from "./RefreshStaleAppList";

interface AppListProps {
	/** Active Project id (Better Auth organizationId): the tenancy scope. */
	projectId: string;
	/** Signed-in user: resolves their role in the active Project. */
	userId: string;
}

/**
 * First-page size. The web surface is non-paginated today: a single
 * card grid up to this many rows. The same number is reused for the
 * recently-deleted list, which is naturally bounded by the 30-day
 * retention window and rarely binds.
 */
const PAGE_SIZE = 50;

export async function AppList({ projectId, userId }: AppListProps) {
	const [activeRes, deletedRes, projects, designs] = await Promise.all([
		listApps(projectId, { limit: PAGE_SIZE, sort: "updated_desc" }),
		listDeletedApps(projectId, { limit: PAGE_SIZE }),
		listUserProjects(userId),
		/* A chat build has no app row until its first workflow commits, so a
		 * design in flight is reachable only through its own section (§15.9).
		 * These read different tables from the app lists and share no
		 * read-after-write dependency, so they run together. */
		listDesignsInProgress({ userId, projectId }),
	]);

	/* Placement is a governance act, so only members who hold it in BOTH Projects
	 * see the control, and the destination list is exactly the other Projects
	 * where this member holds it. The database re-proves both roles, plus source
	 * owner retention, inside the move transaction. */
	const active = projects.find((p) => p.id === projectId);
	const canMoveApp = Boolean(active && canManageAppPlacement(active.role));
	const moveTargets = canMoveApp
		? projects
				.filter((p) => p.id !== projectId && canManageAppPlacement(p.role))
				.map((p) => ({ id: p.id, name: p.name }))
		: [];
	const canCreateApp = Boolean(active && roleAllowsApp(active.role, "edit"));
	const canDeleteApp = Boolean(active && roleAllowsApp(active.role, "delete"));

	return (
		<>
			{/* An app created in the builder never navigated, so a list reached
			    with Back comes from the client Router Cache and predates it. */}
			<RefreshStaleAppList />
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold tracking-tighter">
					Your apps
				</h1>
				{canCreateApp ? (
					<Button render={<Link href="/build/new" />} nativeButton={false}>
						<Icon icon={tablerPlus} width="14" height="14" />
						New app
					</Button>
				) : null}
			</div>

			<DesignsInProgress designs={designs} />

			<AppListBody
				active={activeRes.apps}
				deleted={deletedRes.apps}
				canDeleteApp={canDeleteApp}
				canMoveApp={canMoveApp}
				moveTargets={moveTargets}
			/>
		</>
	);
}
