/**
 * Main-app layout: wraps every authenticated-app route under `(app)/`.
 *
 * This layer is what used to live in the root layout. It was split out
 * so that public-but-served-from-the-same-app surfaces: currently the
 * docs site under `(docs)/`: don't have to pay for `getSession()`
 * (and the Postgres round-trip it triggers) on every request. With
 * this split, docs requests never run the auth lookup, and the docs
 * subdomain stays available even if Postgres is briefly unreachable.
 *
 * The header is HERE, not in either route group, and that is the whole
 * reason this layout now resolves the session. `(site)` and `build` are
 * siblings: a header rendered in either is destroyed and rebuilt every time
 * the user crosses between them, and nothing that is rebuilt can animate
 * across the crossing. `AppChrome` owns the band; each surface fills it from
 * below (`components/ui/headerSlots`). Each group still owns its own
 * `#main-content` wrapper — scrolling site pages vs the builder's fixed
 * full-height shell.
 *
 * The `nova-noise` class lives here, on the wrapper div: its `::before`
 * is fixed-position, so it still covers the whole viewport even though
 * it's no longer applied at `<body>`. The docs subtree intentionally
 * doesn't carry it: the noise texture is part of the builder feel,
 * not the docs feel.
 */
import { ErrorReporter } from "@/components/ErrorReporter";
import { SentryUser } from "@/components/SentryUser";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { AppChrome } from "@/components/ui/AppChrome";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { listUserProjects } from "@/lib/projects/membership";

export default async function AppLayout({
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
	 * both calls with every page's. */
	let projects: Awaited<ReturnType<typeof listUserProjects>> = [];
	let activeProjectId: string | null = null;
	if (session) {
		activeProjectId = await resolveActiveProjectId(session);
		projects = await listUserProjects(session.user.id);
	}

	return (
		<div
			data-nova-app-shell
			className="nova-noise flex flex-col h-dvh bg-nova-void"
		>
			{/* Skip link: visually hidden until focused, jumps keyboard users past the header chrome. */}
			<a
				href="#main-content"
				className="nova-focusable sr-only focus:not-sr-only focus:absolute focus:z-system focus:top-2 focus:left-2 focus:flex focus:min-h-11 focus:items-center focus:rounded-xl focus:bg-nova-action focus:px-4 focus:text-sm focus:font-medium focus:text-nova-action-ink"
			>
				Skip to main content
			</a>
			<ErrorReporter />
			<SentryUser />
			<TooltipProvider>
				<AppChrome
					isAdmin={isAdmin}
					isAuthenticated={!!session}
					impersonating={impersonating}
					projects={projects}
					activeProjectId={activeProjectId}
				>
					{children}
				</AppChrome>
				<ToastContainer />
			</TooltipProvider>
		</div>
	);
}
