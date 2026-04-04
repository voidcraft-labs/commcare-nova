/**
 * Build layout — auth gate for all /build/* routes.
 *
 * Enforces authentication before any builder page renders. Unauthenticated
 * users are redirected to `/` (the landing page). The global header is
 * rendered by the root layout.
 */
import { requireAuth } from "@/lib/auth-utils";

export default async function BuildLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAuth();
	return children;
}
