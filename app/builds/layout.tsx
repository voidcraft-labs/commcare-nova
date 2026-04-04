/**
 * Builds layout — auth gate for the /builds segment.
 *
 * The global header is rendered by the root layout. This layout only
 * enforces authentication — unauthenticated users are redirected to `/`
 * before any page content is sent.
 */
import { requireAuth } from "@/lib/auth-utils";

export default async function BuildsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireAuth();
	return children;
}
