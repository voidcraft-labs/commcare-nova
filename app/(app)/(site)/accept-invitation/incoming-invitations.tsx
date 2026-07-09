/**
 * Incoming invitations — the surface where a signed-in user accepts or
 * declines the Project invitations addressed to them. No invitation email is
 * sent, so this list is how an invitee discovers a pending invite.
 *
 * Accept/decline go through Better Auth's organization client; on accept we set
 * the joined Project active and route to the app list (the user lands in the
 * Project they just joined). The pending list is resolved server-side and
 * passed in.
 */

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { IncomingInvitationRow } from "@/lib/projects/membership";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { showToast } from "@/lib/ui/toastStore";

export function IncomingInvitations({
	invitations,
}: {
	invitations: IncomingInvitationRow[];
}) {
	const navigate = useExternalNavigate();
	const [busy, setBusy] = useState(false);

	async function accept(inv: IncomingInvitationRow) {
		if (busy) return;
		setBusy(true);
		const { error } = await authClient.organization.acceptInvitation({
			invitationId: inv.id,
		});
		if (error) {
			setBusy(false);
			showToast(
				"error",
				"Couldn't accept invitation",
				error.message ?? "It may have expired. Ask for a new one.",
			);
			return;
		}
		/* Land in the Project just joined — set it active, then go to the app
		 * list. A failure to set active isn't fatal (the membership stands); the
		 * switcher can still select it. */
		await authClient.organization.setActive({
			organizationId: inv.organizationId,
		});
		showToast(
			"info",
			"Joined",
			`You're now a member of ${inv.organizationName}.`,
		);
		navigate.push("/");
		navigate.refresh();
	}

	async function decline(inv: IncomingInvitationRow) {
		if (busy) return;
		setBusy(true);
		const { error } = await authClient.organization.rejectInvitation({
			invitationId: inv.id,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't decline invitation",
				error.message ?? "Try again in a moment.",
			);
			return;
		}
		navigate.refresh();
	}

	if (invitations.length === 0) {
		return (
			<p className="text-sm text-nova-text-muted">
				You have no pending invitations.
			</p>
		);
	}

	return (
		<ul className="space-y-3">
			{invitations.map((inv) => (
				<li
					key={inv.id}
					className="flex items-center gap-3 rounded-xl border border-nova-border bg-nova-surface p-4"
				>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium text-nova-text">
							{inv.organizationName}
						</div>
						<div className="text-xs text-nova-text-muted">
							Invited as{" "}
							{(inv.role ?? "viewer").replace(/^\w/, (c) => c.toUpperCase())} ·
							expires {inv.expiresAt.toLocaleDateString()}
						</div>
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() => decline(inv)}
						className="rounded-lg px-3 py-2 text-sm text-nova-text-muted not-disabled:hover:text-nova-text transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
					>
						Decline
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => accept(inv)}
						className="rounded-lg bg-nova-action px-3 py-2 text-sm font-medium text-white not-disabled:hover:bg-nova-action-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
					>
						Accept
					</button>
				</li>
			))}
		</ul>
	);
}
