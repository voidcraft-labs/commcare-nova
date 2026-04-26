/**
 * Admin layout — admin gate for the entire /admin/* tree.
 *
 * The global header is rendered by the root layout. This layout only
 * enforces admin access — non-admins are redirected before any HTML is sent.
 */
import { requireAdminAccess } from "@/lib/auth-utils";

export default async function AdminLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAdminAccess();
	return children;
}
