/**
 * The app shell's one header, mounted once for the whole signed-in app.
 *
 * It lives in `(app)/layout.tsx`, above BOTH route groups, and that placement
 * is the feature. `(site)` and `build` are siblings: crossing between them
 * unmounts one and mounts the other, so a header rendered inside either is
 * destroyed and rebuilt on every crossing. Matching the geometry made the
 * rebuild invisible; it did not make it stop happening, and nothing that is
 * rebuilt can animate across the moment it is rebuilt. Up here the band is one
 * element for the life of the session, so the app list and the builder are the
 * same page wearing different menus.
 *
 * This component owns what is constant — the mark, the account control, the
 * impersonation banner — plus the site's own menus. Everything else arrives as
 * a CLAIM from the surface below (`components/ui/headerSlots`): the claiming
 * surface says what the band should be, its controls portal into the band's
 * cells, and the site's menus step aside for the duration.
 *
 * The site's menus are server-rendered, unconditionally. They have to be: they
 * are the only navigation on every non-builder page, and gating them on a
 * client mount takes them out of the HTML — invisible for the whole hydration
 * window on a slow connection, and gone entirely if the bundle never arrives.
 *
 * That leaves the band's server render structurally unable to know it is
 * inside a build, since a claim can only come from below it. Two things cover
 * that gap, and neither is this component's own state: `BuilderBandClaim`
 * claims in the first client commit, and a server-rendered marker plus one
 * `:has()` rule in `globals.css` settles the first PAINT (see
 * `build/[id]/layout.tsx`). What survives here is the claim itself, which
 * owns everything after that first paint.
 */

"use client";

import { AnimatePresence } from "motion/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { AppHeader } from "@/components/ui/AppHeader";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import {
	HEADER_HANDOFF_DELAY,
	HeaderCluster,
} from "@/components/ui/headerMotion";
import {
	type HeaderClaim,
	HeaderSlotsProvider,
	sameHeaderClaim,
} from "@/components/ui/headerSlots";
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { ProjectSwitcher } from "@/components/ui/ProjectSwitcher";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { ProjectSummary } from "@/lib/projects/membership";

interface AppChromeProps {
	/** Whether the current user has admin role: controls the Admin nav link. */
	isAdmin: boolean;
	/** Whether the user is authenticated: an unauthenticated `/` is the
	 *  landing page and carries no header at all. */
	isAuthenticated: boolean;
	/** Active impersonation info, or null when viewing as yourself. */
	impersonating: { userName: string; userEmail: string } | null;
	/** Every Project the user belongs to: backs the switcher. */
	projects: ProjectSummary[];
	/** The active Project id (the tenancy scope), or null when unauthenticated. */
	activeProjectId: string | null;
	/** The route content, under the band. */
	children: ReactNode;
}

export function AppChrome({
	isAdmin,
	isAuthenticated,
	impersonating,
	projects,
	activeProjectId,
	children,
}: AppChromeProps) {
	const [claim, setClaim] = useState<HeaderClaim | null>(null);
	const [centerSlot, setCenterSlot] = useState<HTMLElement | null>(null);
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
	/* Claims are rebuilt every render by whatever is claiming, so hold the
	 * value and ignore an identical one: storing each new object would
	 * re-render the band on every keystroke in the builder. */
	const claimBand = useCallback((next: HeaderClaim | null) => {
		setClaim((current) => (sameHeaderClaim(current, next) ? current : next));
	}, []);

	/* The slot targets are the only thing consumers read, and they settle once
	 * at mount, so a claim never re-renders the surfaces reading this. */
	const slots = useMemo(
		() => ({ center: centerSlot, actions: actionsSlot, claim: claimBand }),
		[centerSlot, actionsSlot, claimBand],
	);

	if (!isAuthenticated) return children;

	const activeProject = projects.find(
		(project) => project.id === activeProjectId,
	);
	const canEditActiveProject = Boolean(
		activeProject && roleAllowsApp(activeProject.role, "edit"),
	);

	/* The band's own menus are the unclaimed state. */
	const siteMenus = claim === null;

	const banner = impersonating ? (
		<ImpersonationBanner
			userName={impersonating.userName}
			userEmail={impersonating.userEmail}
		/>
	) : null;

	const showAccount = claim ? claim.showAccount : true;
	const canManageFiles = claim ? claim.canManageFiles : canEditActiveProject;

	return (
		<HeaderSlotsProvider value={slots}>
			<AppHeader
				homeLabel={claim?.homeLabel ?? "commcare nova"}
				markOnly={claim?.markOnly ?? false}
				handoff={claim?.handoff ?? false}
				stacked={claim?.stacked ?? false}
				/* Beside the mark on every surface. It used to be centred on the
				 * site, but the centre is where a claimed control the user is meant
				 * to reach goes, and one placement everywhere is worth more than the
				 * extra prominence. */
				banner={banner}
				start={
					/* `data-header-site-menus` is what the build marker's `:has()` rule
					   in `globals.css` hides, and it sits on a plain wrapper rather
					   than being handed to `HeaderCluster`: the wrapper is here in the
					   server HTML whether or not the cluster inside it is, which is
					   exactly what has to be true for CSS to settle the first paint. */
					<span data-header-site-menus className="flex min-w-0 items-center">
						{/* The `AnimatePresence` is rendered unconditionally and the
						    CONTENT is what comes and goes. Swapping the presence itself
						    for other content would take the nav's exit with it: a
						    presence can only animate a child it is still rendering, so
						    the nav would vanish in a frame at the exact moment the
						    handoff is meant to be visible. */}
						<AnimatePresence>
							{siteMenus ? (
								<HeaderCluster
									key="site-nav"
									delay={HEADER_HANDOFF_DELAY}
									className="flex min-w-0 items-center"
								>
									<HeaderNavLinks isAdmin={isAdmin} />
								</HeaderCluster>
							) : null}
						</AnimatePresence>
					</span>
				}
				/* A real box, not `display: contents`. The band places its overlap
				 * grid's DIRECT children, and a contents span is skipped by that
				 * rule while its portaled child — the actual grid item — is left
				 * unplaced and auto-flows into a second row. */
				center={
					<span ref={setCenterSlot} className="flex min-w-0 items-center" />
				}
				actions={
					<>
						<span
							ref={setActionsSlot}
							className="flex min-w-0 items-center justify-end"
						/>
						<span data-header-site-menus className="flex min-w-0 items-center">
							<AnimatePresence>
								{siteMenus ? (
									<HeaderCluster
										key="site-actions"
										delay={HEADER_HANDOFF_DELAY}
									>
										<ProjectSwitcher
											projects={projects}
											activeProjectId={activeProjectId}
										/>
									</HeaderCluster>
								) : null}
							</AnimatePresence>
						</span>
					</>
				}
				account={
					showAccount ? (
						/* Files is Project-scoped. A key change closes its dialog and
						 * unmounts the old library/upload/delete controllers before the
						 * new Project can render, so no stale asset list crosses the
						 * tenancy boundary. */
						<AccountMenu
							key={activeProjectId ?? "no-active-project"}
							canManageFiles={canManageFiles}
						/>
					) : null
				}
			/>
			{children}
		</HeaderSlotsProvider>
	);
}
