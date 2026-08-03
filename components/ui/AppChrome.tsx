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
 * The site's menus wait for mount before rendering, which is deliberate and
 * costs them one frame on the app list. A claim can only come from BELOW this
 * component, so it cannot exist during the server render — and a band that
 * rendered site menus on the server would flash the nav, the Project switcher,
 * and Help inside the builder on every hard load of `/build/*`. Waiting a
 * frame lets the claim land in the same commit, and the wrong menus are never
 * painted at all. The account control already sets this precedent for its own
 * reasons. The other half of that guarantee is `BuilderBandClaim`, which
 * claims from the build route's LAYOUT rather than its page, so a page that
 * awaits its data cannot leave the band unclaimed while it reads.
 */

"use client";

import { AnimatePresence } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { AppHeader } from "@/components/ui/AppHeader";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import { HelpMenu } from "@/components/ui/HelpMenu";
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
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

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
	const siteMenus = mounted && claim === null;

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
				stacked={claim?.stacked ?? false}
				/* Beside the mark on every surface. It used to be centred on the
				 * site, but the centre is where a claimed control the user is meant
				 * to reach goes, and one placement everywhere is worth more than the
				 * extra prominence. */
				banner={banner}
				start={
					<>
						{/* The `AnimatePresence` is rendered unconditionally and the
						    CONTENT is what comes and goes. Swapping the presence itself
						    for the banner would take the nav's exit with it: a presence
						    can only animate a child it is still rendering, so the nav
						    would vanish in a frame at the exact moment the handoff is
						    meant to be visible. */}
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
					</>
				}
				/* `contents`, so a claimed control lands as a child of the centre
				 * cell itself and inherits its placement. */
				center={<span ref={setCenterSlot} className="contents" />}
				actions={
					<>
						<span ref={setActionsSlot} className="contents" />
						<AnimatePresence>
							{siteMenus ? (
								<HeaderCluster key="site-actions" delay={HEADER_HANDOFF_DELAY}>
									<ProjectSwitcher
										projects={projects}
										activeProjectId={activeProjectId}
									/>
									<HelpMenu />
								</HeaderCluster>
							) : null}
						</AnimatePresence>
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
