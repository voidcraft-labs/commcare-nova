/**
 * Build layout — auth gate + shell for all /build/* routes.
 *
 * Enforces authentication before any builder page renders;
 * unauthenticated users are redirected to `/` (the landing page).
 *
 * The builder renders its own chrome (`BuilderHeader` inside
 * BuilderLayout) instead of the site's AppHeader — see
 * `(site)/layout.tsx` for the split rationale. The wrapper here is the
 * builder's `#main-content`: a fixed full-height flex cell (the
 * builder owns its internal scrolling), unlike the site group's
 * `overflow-auto` document scroller.
 */
import { requireAuth } from "@/lib/auth-utils";

export default async function BuildLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAuth();
	return (
		<div id="main-content" className="flex-1 min-h-0 flex flex-col">
			{children}
		</div>
	);
}
