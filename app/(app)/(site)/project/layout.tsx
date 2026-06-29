/**
 * Project-settings layout — auth gate for the /project tree.
 *
 * Requires an authenticated session. Non-authenticated users are
 * redirected to the landing page by `requireAuth()` (mirrors the
 * /settings gate; the shared `(site)` layout only reads the session,
 * it doesn't require one).
 */
import { requireAuth } from "@/lib/auth-utils";

export default async function ProjectSettingsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAuth();
	return children;
}
