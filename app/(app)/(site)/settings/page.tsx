/**
 * Settings page. Auth is enforced by the layout's `requireAuth`; the
 * session check below only narrows the type for TypeScript.
 */
import type { Metadata } from "next";
import { roleCanManageProject } from "@/lib/auth/projectRoles";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { listUserApiKeys } from "@/lib/db/api-keys";
import { listAuthorizedClients } from "@/lib/db/oauth-consents";
import { getCommCareSettings } from "@/lib/db/settings";
import {
	listPendingInvitations,
	listProjectMembers,
	listUserProjects,
} from "@/lib/projects/membership";
import { ApiKeys } from "./api-keys";
import { CommCareSettings } from "./commcare-settings";
import { ConnectedApps } from "./connected-apps";
import { ProjectMembers } from "./project-members";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
	const session = await getSession();
	if (!session) return null;

	/* Resolve the active Project FIRST: it get-or-creates the user's personal
	 * Project (a WRITE to `auth_member`), so it must commit before
	 * `listUserProjects` READS that table — otherwise a legacy user's freshly
	 * provisioned Project can be missing from the switcher list. `cache()` makes
	 * the layout's own call free. The remaining reads are independent. */
	const activeProjectId = await resolveActiveProjectId(session);

	const [
		initialSettings,
		initialAuthorizedClients,
		initialApiKeys,
		projects,
		members,
		invitations,
	] = await Promise.all([
		getCommCareSettings(session.user.id),
		listAuthorizedClients(session.user.id),
		listUserApiKeys(session.user.id),
		listUserProjects(session.user.id),
		listProjectMembers(activeProjectId),
		listPendingInvitations(activeProjectId),
	]);

	const activeProject = projects.find((p) => p.id === activeProjectId);

	return (
		<main className="max-w-2xl mx-auto px-6 py-12">
			<h1 className="text-2xl font-display font-semibold mb-8">Settings</h1>
			<div className="space-y-6">
				{activeProject && (
					<div id="members" className="scroll-mt-20">
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
				)}
				<CommCareSettings
					initial={initialSettings}
					userEmail={session.user.email}
				/>
				<ConnectedApps initial={initialAuthorizedClients} />
				<ApiKeys initial={initialApiKeys} />
			</div>
		</main>
	);
}
