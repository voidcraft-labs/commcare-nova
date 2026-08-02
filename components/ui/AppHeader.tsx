/**
 * Site header: rendered by `(site)/layout.tsx` for every non-builder
 * surface (app list, admin, settings, consent). The builder renders
 * `BuilderHeader` instead; the split lives at the route group.
 *
 * Always visible when the user is authenticated. Hidden on the landing
 * page (unauthenticated `/`). Uses `isAuthenticated` from the server-resolved
 * session rather than pathname checks: the same `/` route renders both
 * the landing and the app list depending on auth state.
 */

"use client";

import Link from "next/link";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import { HelpMenu } from "@/components/ui/HelpMenu";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { Logo } from "@/components/ui/Logo";
import { ProjectSwitcher } from "@/components/ui/ProjectSwitcher";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { ProjectSummary } from "@/lib/projects/membership";

interface ImpersonationState {
	userName: string;
	userEmail: string;
}

interface AppHeaderProps {
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

export function AppHeader({
	isAdmin,
	isAuthenticated,
	impersonating,
	projects,
	activeProjectId,
}: AppHeaderProps) {
	/* Landing page (unauthenticated): no header. */
	if (!isAuthenticated) return null;
	const activeProject = projects.find(
		(project) => project.id === activeProjectId,
	);
	const canEditActiveProject = Boolean(
		activeProject && roleAllowsApp(activeProject.role, "edit"),
	);

	/* Six 44px controls plus the mark is 300px of real target before any inset,
	 * so at 320px the row spends its remaining pixels on the controls rather
	 * than on margins; above that the ordinary insets return. Nothing here
	 * shrinks a control: the floor is a floor. */
	return (
		<header className="flex shrink-0 items-center border-b border-nova-border bg-nova-void px-2 py-2.5 sm:px-4">
			{/* The wordmark appears only where the whole lockup fits beside the
			    nav and the account cluster. At the mark's chrome size that is
			    ~470px of lockup, so the breakpoint is the width the row needs,
			    not a nominal "phone" one: below it the sphere carries the brand
			    alone and `markOnly` keeps the accessible name. */}
			<Link
				href="/"
				aria-label="commcare nova"
				className="nova-focusable flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl sm:px-1 lg:justify-start"
			>
				<span className="lg:hidden">
					<Logo size="chrome" markOnly />
				</span>
				<span className="hidden lg:block">
					<Logo size="chrome" />
				</span>
			</Link>
			{/* No margin at the narrowest width: the nav links carry their own
			    12px inset, so the gap is still visible without spending a
			    pixel the row does not have. */}
			<div className="sm:ml-4">
				<HeaderNavLinks isAdmin={isAdmin} />
			</div>

			{impersonating ? (
				<div className="flex-1 flex justify-center">
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				</div>
			) : null}

			<div className="ml-auto flex items-center gap-1 sm:gap-2">
				<ProjectSwitcher
					projects={projects}
					activeProjectId={activeProjectId}
				/>
				<HelpMenu />
				{/* Files is Project-scoped. A key change closes its dialog and unmounts
				 * the old library/upload/delete controllers before the new Project can
				 * render, so no stale asset list crosses the tenancy boundary. */}
				<AccountMenu
					key={activeProjectId ?? "no-active-project"}
					canManageFiles={canEditActiveProject}
				/>
			</div>
		</header>
	);
}
