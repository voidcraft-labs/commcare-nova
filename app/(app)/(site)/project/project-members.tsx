/**
 * Project members — the Project-settings card that manages who shares the
 * active Project and at what role. Admins and owners can invite (dimagi addresses
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
 * passed down (see `project/page.tsx`).
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerUsers from "@iconify-icons/tabler/users";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
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

/** Plain-language summary of what each role can do, shown in the header's
 *  role-info popover so whoever assigns a role knows what they're granting.
 *  Keyed by every role the UI shows. Kept faithful to `lib/auth/projectRoles`:
 *  viewer = app:view, editor = app:view+edit, admin adds member management,
 *  owner adds Project-level control; the owner is never removable/re-rolable
 *  here (the roster gates every action behind `!isOwner`). */
const ROLE_DESCRIPTIONS: Record<
	"viewer" | "editor" | "admin" | "owner",
	string
> = {
	viewer:
		"Can open and preview this Project's apps and case data — but can't change anything.",
	editor:
		"Can build and edit the Project's apps and case data. Can't invite people or change roles.",
	admin:
		"Everything an editor can do, plus managing people — invite members, change their roles, and remove them. Can't remove or change the owner.",
	owner:
		"Whoever created the Project. Full control, and the one member who can't be removed or have their role changed.",
};

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

	/* A personal Project can't have admins — a guest administering the space
	 * that's meant to be yours alone makes no sense — so its pickers offer
	 * viewer/editor only. A shared Project offers all three assignable roles. */
	const assignableRoles = personal
		? ASSIGNABLE_ROLES.filter((r) => r !== "admin")
		: ASSIGNABLE_ROLES;
	const roleItems = assignableRoles.map((r) => ({
		label: roleLabel(r),
		value: r,
	}));
	/* Roles to explain in the header popover: the ones assignable here plus
	 * owner (always present in the roster, never assignable from this surface). */
	const legendRoles: (keyof typeof ROLE_DESCRIPTIONS)[] = [
		...assignableRoles,
		"owner",
	];

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
		<section className="rounded-xl border border-nova-border bg-nova-surface overflow-hidden">
			{/* ── Card header ───────────────────────────────────────── */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-nova-border/50">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nova-violet/10">
					<Icon
						icon={tablerUsers}
						width="18"
						height="18"
						className="text-nova-violet-bright"
					/>
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="text-base font-display font-semibold text-nova-text">
						Members
					</h2>
					<p className="text-xs text-nova-text-muted">
						{personal
							? "Invite teammates to turn your personal Project into a shared one."
							: "Members share this Project's apps and case data; roles control what each can do."}
					</p>
				</div>
				<Popover>
					<PopoverTrigger
						aria-label="What the roles mean"
						className="shrink-0 inline-flex items-center justify-center rounded-md p-1 text-nova-text-muted transition-colors cursor-pointer hover:text-nova-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerInfoCircle} width="16" height="16" />
					</PopoverTrigger>
					<PopoverContent className="w-80">
						<p className="text-xs font-medium uppercase tracking-wide text-nova-text-muted">
							What each role can do
						</p>
						{legendRoles.map((r) => (
							<div key={r}>
								<p className="text-sm font-medium text-nova-text">
									{roleLabel(r)}
								</p>
								<p className="text-xs text-nova-text-muted leading-relaxed">
									{ROLE_DESCRIPTIONS[r]}
								</p>
							</div>
						))}
					</PopoverContent>
				</Popover>
			</div>

			<div className="p-6">
				{/* Invite — admins/owners only */}
				{canManage && (
					<div className="mb-6 flex flex-wrap items-center gap-2">
						<Input
							type="email"
							autoComplete="off"
							data-1p-ignore
							value={inviteEmail}
							onChange={(e) => setInviteEmail(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") invite();
							}}
							placeholder={`name@${INVITE_ALLOWED_DOMAINS[0]}`}
							className="min-w-[220px] flex-1"
						/>
						<Select
							items={roleItems}
							value={inviteRole}
							onValueChange={(next) => setInviteRole(next as AssignableRole)}
						>
							<SelectTrigger aria-label="Invite role">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{assignableRoles.map((r) => (
									<SelectItem key={r} value={r}>
										{roleLabel(r)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							type="button"
							disabled={!inviteEmail.trim() || busy}
							onClick={invite}
						>
							Invite
						</Button>
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
									<Select
										items={roleItems}
										value={normalizeRole(m.role)}
										disabled={busy}
										onValueChange={(next) =>
											changeRole(m.memberId, next as AssignableRole)
										}
									>
										<SelectTrigger size="sm" aria-label={`Role for ${m.name}`}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{assignableRoles.map((r) => (
												<SelectItem key={r} value={r}>
													{roleLabel(r)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : (
									<span className="text-sm text-nova-text-muted">
										{roleLabel(m.role)}
									</span>
								)}
								{canEditThis && (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={busy}
										onClick={() => removeMember(m.memberId)}
										aria-label={`Remove ${m.name}`}
									>
										<Icon icon={tablerTrash} width="16" height="16" />
									</Button>
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
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={busy}
											onClick={() => cancelInvitation(inv.id)}
										>
											Cancel
										</Button>
									)}
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
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
