/**
 * Replay layout — admin gate for all /build/replay/* routes.
 *
 * Inherits the base auth check from app/build/layout.tsx (requireAuth).
 * This layout adds the admin requirement since replay is an admin-only
 * debugging tool. Non-admins are redirected before any HTML is sent.
 */
import { requireAdminAccess } from "@/lib/auth-utils";

export default async function ReplayLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAdminAccess();
	return children;
}
