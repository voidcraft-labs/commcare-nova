/**
 * Accept-invitation page — where a signed-in user reviews and acts on the
 * Project invitations addressed to their email. Reachable from the home-page
 * banner (shown when invites are pending) and a stable link.
 *
 * Auth-gated: an unauthenticated visitor is redirected to sign in first
 * (accepting requires a logged-in user, per Better Auth). Invitations are
 * matched to the session user's email server-side.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-utils";
import { listIncomingInvitations } from "@/lib/projects/membership";
import { IncomingInvitations } from "./incoming-invitations";

export const metadata: Metadata = { title: "Invitations" };

export default async function AcceptInvitationPage() {
	const session = await getSession();
	if (!session) redirect("/");

	const invitations = await listIncomingInvitations(
		session.user.email,
		new Date(),
	);

	return (
		<main className="max-w-2xl mx-auto px-6 py-12">
			<h1 className="text-2xl font-display font-semibold mb-2">Invitations</h1>
			<p className="mb-8 text-sm text-nova-text-muted">
				Project invitations addressed to {session.user.email}. Accepting joins
				you to the Project's shared apps and case data.
			</p>
			<IncomingInvitations invitations={invitations} />
		</main>
	);
}
