/**
 * Project members — the settings section that manages who shares the active
 * Project and at what role. Admins and owners can invite (dimagi addresses
 * only — the server's `beforeCreateInvitation` hook enforces it and its
 * rejection surfaces here), change a member's role, remove a member, and
 * cancel a pending invitation. Everyone sees the roster read-only.
 *
 * Mutations go through Better Auth's organization client
 * (`authClient.organization.*`) — the org HTTP endpoints are live and
 * authorized server-side by the role access-control rules, so a viewer/editor
 * who forged a request would still be refused. After each success we
 * `navigate.refresh()` so the server-fetched roster/invitation lists re-render.
 *
 * Initial lists + the caller's `canManage` flag are resolved server-side and
 * passed down (see `settings/page.tsx`).
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { INVITE_ALLOWED_DOMAINS } from "@/lib/projects/invitePolicy";
import type {
	ProjectInvitationRow,
	ProjectMemberRow,
} from "@/lib/projects/membership";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { showToast } from "@/lib/ui/toastStore";

/** Roles an invite or role-change may assign. Owner is the creator's role and
 *  isn't reassignable here (ownership transfer is out of scope). */
const ASSIGNABLE_ROLES = ["viewer", "editor", "admin"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

interface ProjectMembersProps {
	projectId: string;
	projectName: string;
	/** Whether the active Project is the user's auto-provisioned personal one. */
	personal: boolean;
	/** Whether the caller may invite / change roles / remove (admin or owner). */
	canManage: boolean;
	currentUserId: string;
	members: ProjectMemberRow[];
	invitations: ProjectInvitationRow[];
}

export function ProjectMembers({
	projectId,
	projectName,
	personal,
	canManage,
	currentUserId,
	members,
	invitations,
}: ProjectMembersProps) {
	const navigate = useExternalNavigate();
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<AssignableRole>("editor");
	const [busy, setBusy] = useState(false);

	async function invite() {
		const email = inviteEmail.trim().toLowerCase();
		if (!email || busy) return;
		setBusy(true);
		const { error } = await authClient.organization.inviteMember({
			email,
			role: inviteRole,
			organizationId: projectId,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't send invitation",
				error.message ?? "Check the address and try again.",
			);
			return;
		}
		setInviteEmail("");
		showToast(
			"info",
			"Invitation sent",
			`${email} can now join ${projectName}.`,
		);
		navigate.refresh();
	}

	async function changeRole(memberId: string, role: AssignableRole) {
		setBusy(true);
		const { error } = await authClient.organization.updateMemberRole({
			memberId,
			role,
			organizationId: projectId,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't change role",
				error.message ?? "Try again in a moment.",
			);
			return;
		}
		navigate.refresh();
	}

	async function removeMember(memberId: string) {
		setBusy(true);
		const { error } = await authClient.organization.removeMember({
			memberIdOrEmail: memberId,
			organizationId: projectId,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't remove member",
				error.message ?? "Try again in a moment.",
			);
			return;
		}
		navigate.refresh();
	}

	async function cancelInvitation(invitationId: string) {
		setBusy(true);
		const { error } = await authClient.organization.cancelInvitation({
			invitationId,
		});
		setBusy(false);
		if (error) {
			showToast(
				"error",
				"Couldn't cancel invitation",
				error.message ?? "Try again in a moment.",
			);
			return;
		}
		navigate.refresh();
	}

	return (
		<section className="rounded-xl border border-nova-border bg-nova-surface p-6">
			<div className="mb-1 flex items-center justify-between gap-3">
				<h2 className="text-lg font-display font-semibold">Project members</h2>
				<span className="text-sm text-nova-text-muted truncate">
					{projectName}
				</span>
			</div>
			<p className="mb-5 text-sm text-nova-text-muted">
				Members of a Project share its apps and case data.{" "}
				{personal
					? "Invite teammates here to turn your personal Project into a shared one."
					: "Roles control what each member can do."}
			</p>

			{/* Invite — admins/owners only */}
			{canManage && (
				<div className="mb-6 flex flex-wrap items-center gap-2">
					<input
						type="email"
						autoComplete="off"
						data-1p-ignore
						value={inviteEmail}
						onChange={(e) => setInviteEmail(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") invite();
						}}
						placeholder={`name@${INVITE_ALLOWED_DOMAINS[0]}`}
						className="min-w-[220px] flex-1 rounded-lg border border-nova-border bg-nova-void px-3 py-2 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
					/>
					<select
						value={inviteRole}
						onChange={(e) => setInviteRole(e.target.value as AssignableRole)}
						className="rounded-lg border border-nova-border bg-nova-void px-3 py-2 text-sm text-nova-text focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
					>
						{ASSIGNABLE_ROLES.map((r) => (
							<option key={r} value={r}>
								{roleLabel(r)}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={!inviteEmail.trim() || busy}
						onClick={invite}
						className="rounded-lg bg-nova-action px-3 py-2 text-sm font-medium text-white hover:bg-nova-action-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
					>
						Invite
					</button>
				</div>
			)}

			{/* Roster */}
			<ul className="divide-y divide-nova-border">
				{members.map((m) => {
					const isSelf = m.userId === currentUserId;
					const isOwner = m.role.includes("owner");
					const canEditThis = canManage && !isOwner && !isSelf;
					return (
						<li key={m.memberId} className="flex items-center gap-3 py-3">
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium text-nova-text">
									{m.name}
									{isSelf && (
										<span className="ml-1.5 text-xs text-nova-text-muted">
											You
										</span>
									)}
								</div>
								<div className="truncate text-xs text-nova-text-muted">
									{m.email}
								</div>
							</div>
							{canEditThis ? (
								<select
									value={normalizeRole(m.role)}
									disabled={busy}
									onChange={(e) =>
										changeRole(m.memberId, e.target.value as AssignableRole)
									}
									className="rounded-lg border border-nova-border bg-nova-void px-2.5 py-1.5 text-sm text-nova-text focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none disabled:opacity-40"
								>
									{ASSIGNABLE_ROLES.map((r) => (
										<option key={r} value={r}>
											{roleLabel(r)}
										</option>
									))}
								</select>
							) : (
								<span className="text-sm text-nova-text-muted">
									{roleLabel(m.role)}
								</span>
							)}
							{canEditThis && (
								<button
									type="button"
									disabled={busy}
									onClick={() => removeMember(m.memberId)}
									aria-label={`Remove ${m.name}`}
									className="flex items-center justify-center min-w-[36px] min-h-[36px] rounded-lg text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
								>
									<Icon icon={tablerTrash} width="16" height="16" />
								</button>
							)}
						</li>
					);
				})}
			</ul>

			{/* Pending invitations */}
			{invitations.length > 0 && (
				<div className="mt-6">
					<h3 className="mb-2 text-sm font-medium text-nova-text-muted">
						Pending invitations
					</h3>
					<ul className="divide-y divide-nova-border">
						{invitations.map((inv) => (
							<li key={inv.id} className="flex items-center gap-3 py-2.5">
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm text-nova-text">
										{inv.email}
									</div>
									<div className="text-xs text-nova-text-muted">
										Invited as {roleLabel(inv.role ?? "viewer")} · expires{" "}
										{inv.expiresAt.toLocaleDateString()}
									</div>
								</div>
								{canManage && (
									<button
										type="button"
										disabled={busy}
										onClick={() => cancelInvitation(inv.id)}
										className="text-sm text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
									>
										Cancel
									</button>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

/** Human label for a role string (handles the comma-joined multi-role case by
 *  showing the most-privileged). */
function roleLabel(role: string): string {
	const r = normalizeRole(role);
	return r.charAt(0).toUpperCase() + r.slice(1);
}

/** Collapse a (possibly comma-joined) role to the single role the UI shows,
 *  preferring the most privileged. `member` is the plugin default aliased to
 *  read-only, so it presents as `viewer`. */
function normalizeRole(role: string): string {
	const parts = role.split(",");
	for (const candidate of ["owner", "admin", "editor", "viewer"]) {
		if (parts.includes(candidate)) return candidate;
	}
	return "viewer";
}
