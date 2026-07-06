/**
 * Project settings — the settings that belong to the ACTIVE Project (not the
 * account). Reached from the header's ProjectSwitcher ("Project settings"), NOT
 * from the account-menu → Settings page: members + invitations are Project-
 * scoped and follow the switcher, so they live on their own page with the
 * Project named as the page heading, rather than buried among account-scoped
 * settings (HQ credentials, connected apps, API keys) that are yours regardless
 * of Project. Auth is enforced by the route group's layout; the session check
 * below only narrows the type for TypeScript.
 */
import type { Metadata } from "next";
import { roleCanManageProject } from "@/lib/auth/projectRoles";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import {
	listPendingInvitations,
	listProjectMembers,
	listUserProjects,
} from "@/lib/projects/membership";
import { ProjectMembers } from "./project-members";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage() {
	const session = await getSession();
	if (!session) return null;

	/* Resolve the active Project FIRST: it get-or-creates the user's personal
	 * Project (a WRITE to `auth_member`), so it must commit before
	 * `listUserProjects` READS that table. `cache()` makes the layout's own call
	 * free. The roster + invitations are scoped to that Project. */
	const activeProjectId = await resolveActiveProjectId(session);
	const [projects, members, invitations] = await Promise.all([
		listUserProjects(session.user.id),
		listProjectMembers(activeProjectId),
		listPendingInvitations(activeProjectId),
	]);
	const activeProject = projects.find((p) => p.id === activeProjectId);
	if (!activeProject) return null;

	return (
		<main className="max-w-2xl mx-auto px-6 py-12">
			<div className="mb-8">
				<p className="text-xs font-medium uppercase tracking-wide text-nova-text-muted">
					Project settings
				</p>
				<h1 className="text-2xl font-display font-semibold">
					{activeProject.name}
				</h1>
			</div>
			<div className="space-y-6">
				<ProjectMembers
					projectId={activeProject.id}
					projectName={activeProject.name}
					personal={activeProject.personal}
					canManage={roleCanManageProject(activeProject.role)}
					currentUserId={session.user.id}
					members={members}
					invitations={invitations}
				/>
			</div>
		</main>
	);
}
