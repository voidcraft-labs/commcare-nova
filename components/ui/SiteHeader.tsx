/**
 * What the shared header holds outside the builder: the app list, admin,
 * settings, consent. Rendered by `(site)/layout.tsx`.
 *
 * The band itself is `AppHeader`'s, and everything about it — height, insets,
 * the mark's position, the wordmark's breakpoint — is deliberately not
 * spelled here, because the builder must land in exactly the same place.
 *
 * Hidden on the landing page (unauthenticated `/`). That reads off
 * `isAuthenticated` from the server-resolved session rather than the
 * pathname: the same `/` route renders both the landing and the app list
 * depending on who is asking.
 */

"use client";

import { AccountMenu } from "@/components/ui/AccountMenu";
import { AppHeader } from "@/components/ui/AppHeader";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import { HelpMenu } from "@/components/ui/HelpMenu";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { ProjectSwitcher } from "@/components/ui/ProjectSwitcher";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { ProjectSummary } from "@/lib/projects/membership";

interface ImpersonationState {
	userName: string;
	userEmail: string;
}

interface SiteHeaderProps {
	/** Whether the current user has admin role: passed through to HeaderNav. */
	isAdmin: boolean;
	/** Whether the user is authenticated: controls header visibility. */
	isAuthenticated: boolean;
	/** Active impersonation info, or null when viewing as yourself. */
	impersonating: ImpersonationState | null;
	/** Every Project the user belongs to: backs the switcher. */
	projects: ProjectSummary[];
	/** The active Project id (the tenancy scope), or null when unauthenticated. */
	activeProjectId: string | null;
}

export function SiteHeader({
	isAdmin,
	isAuthenticated,
	impersonating,
	projects,
	activeProjectId,
}: SiteHeaderProps) {
	/* Landing page (unauthenticated): no header. */
	if (!isAuthenticated) return null;
	const activeProject = projects.find(
		(project) => project.id === activeProjectId,
	);
	const canEditActiveProject = Boolean(
		activeProject && roleAllowsApp(activeProject.role, "edit"),
	);

	return (
		<AppHeader
			homeLabel="commcare nova"
			start={<HeaderNavLinks isAdmin={isAdmin} />}
			center={
				impersonating ? (
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				) : null
			}
			actions={
				<>
					<ProjectSwitcher
						projects={projects}
						activeProjectId={activeProjectId}
					/>
					<HelpMenu />
				</>
			}
			account={
				/* Files is Project-scoped. A key change closes its dialog and unmounts
				 * the old library/upload/delete controllers before the new Project can
				 * render, so no stale asset list crosses the tenancy boundary. */
				<AccountMenu
					key={activeProjectId ?? "no-active-project"}
					canManageFiles={canEditActiveProject}
				/>
			}
		/>
	);
}
