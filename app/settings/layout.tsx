/**
 * Settings layout — auth gate for the /settings tree.
 *
 * Requires an authenticated session. Non-authenticated users are
 * redirected to the landing page by `requireAuth()`.
 */
import { requireAuth } from "@/lib/auth-utils";

export default async function SettingsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAuth();
	return children;
}
