/**
 * Build layout — auth gate for all /build/* routes.
 *
 * Enforces authentication before any builder page renders. Unauthenticated
 * users are redirected to `/` (the landing page). The global header is
 * rendered by the root layout.
 */
import { requireAuth } from "@/lib/auth-utils";
import { log } from "@/lib/logger";

export default async function BuildLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// [perf] TEMP — auth bucket for the /build/* load. requireAuth → getSession
	// is React-cache()'d and races the page's getSession call, so whichever
	// triggers the real work measures it here; the other reads ~0. Remove with
	// the rest of the `[perf]` logging once the load regression is diagnosed.
	const authStart = performance.now();
	await requireAuth();
	log.info("[perf] build/layout requireAuth", {
		ms: Math.round(performance.now() - authStart),
	});
	return children;
}
