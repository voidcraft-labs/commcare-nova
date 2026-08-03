/**
 * Site layout: the shared header, filled for every non-builder surface
 * (app list, admin, settings, consent).
 *
 * The builder is deliberately OUTSIDE this group: it fills the SAME
 * `AppHeader` band with the document tools and the Preview toggle, and drops
 * the site nav (Apps/Admin links, Docs, Give feedback) that has no job
 * mid-build. Splitting at the route group keeps that suppression structural:
 * no pathname checks.
 */
import { SiteHeader } from "@/components/ui/SiteHeader";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { listUserProjects } from "@/lib/projects/membership";

export default async function SiteLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getSession();
	/* Impersonated sessions are blocked from admin routes, so hide the nav link. */
	const isAdmin =
		session?.user?.role === "admin" && !session?.session?.impersonatedBy;

	/* During impersonation, session.user is the target: pass their
	 * identity so the header banner shows who is being viewed. */
	const impersonating = session?.session?.impersonatedBy
		? { userName: session.user.name, userEmail: session.user.email }
		: null;

	/* The Projects the header switcher offers + which one is active. Resolve the
	 * active Project FIRST: it get-or-creates the personal Project (a WRITE),
	 * which must commit before `listUserProjects` READS membership, or a
	 * just-provisioned Project is missing from the switcher. `cache()` dedupes
	 * both calls with the page's. */
	let projects: Awaited<ReturnType<typeof listUserProjects>> = [];
	let activeProjectId: string | null = null;
	if (session) {
		activeProjectId = await resolveActiveProjectId(session);
		projects = await listUserProjects(session.user.id);
	}

	return (
		<>
			<SiteHeader
				isAdmin={isAdmin}
				isAuthenticated={!!session}
				impersonating={impersonating}
				projects={projects}
				activeProjectId={activeProjectId}
			/>
			<div id="main-content" className="flex-1 overflow-auto">
				{children}
			</div>
		</>
	);
}
