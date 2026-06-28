// Project-membership READS for the Projects UI — the switcher, the members
// settings section, and the accept-invitation surface. Mutations go through
// Better Auth's typed `auth.api.*` (the Server Actions in
// `app/(app)/(site)/settings/project-members-actions.ts`); these are the
// app-domain reads that back the rendering, queried directly off the shared
// `auth_*` tables through `getAuthDb` — the same cross-store pattern
// `lib/db/appAccess.ts` already uses.

import { getAuthDb } from "@/lib/auth/db";

/** One Project the user belongs to — drives the header switcher. */
export interface ProjectSummary {
	id: string;
	name: string;
	slug: string;
	/** The user's role in this Project (`viewer`/`editor`/`admin`/`owner`). */
	role: string;
	/** The auto-provisioned personal Project (its metadata carries the flag). */
	personal: boolean;
}

/** A member row joined to its user identity — the members table. */
export interface ProjectMemberRow {
	/** `auth_member.id` — the handle `removeMember` / `updateMemberRole` take. */
	memberId: string;
	userId: string;
	name: string;
	email: string;
	role: string;
	createdAt: Date;
}

/** A pending invitation on a Project — the invitations list + cancel control. */
export interface ProjectInvitationRow {
	id: string;
	email: string;
	role: string | null;
	expiresAt: Date;
}

/** An invitation addressed to a user, with its Project name — the accept surface. */
export interface IncomingInvitationRow {
	id: string;
	organizationId: string;
	organizationName: string;
	role: string | null;
	expiresAt: Date;
}

/**
 * Whether two users share at least one Project — the authorization primitive
 * for media reads. Media bytes live in their owner's namespace; a Project
 * co-member may read them because they co-edit the owner's shared apps and
 * data. One self-joined existence check on the indexed `auth_member`; the
 * common same-user case is the caller's short-circuit, not a query.
 */
export async function usersShareAnyProject(
	userA: string,
	userB: string,
): Promise<boolean> {
	if (userA === userB) return true;
	const db = await getAuthDb();
	const row = await db
		.selectFrom("auth_member as a")
		.innerJoin("auth_member as b", "a.organizationId", "b.organizationId")
		.select("a.organizationId")
		.where("a.userId", "=", userA)
		.where("b.userId", "=", userB)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

/** Whether a Project's stored metadata marks it the user's personal Project. */
function isPersonalMetadata(metadata: string | null): boolean {
	if (!metadata) return false;
	try {
		return (JSON.parse(metadata) as { personal?: unknown })?.personal === true;
	} catch {
		return false;
	}
}

/**
 * Every Project the user is a member of, with the user's role and display name —
 * the full set the header switcher offers. Personal Project(s) sort first, then
 * by name, so the default scope leads. One indexed join on the
 * `(organizationId, userId)`-unique `auth_member`, so one row per Project.
 */
export async function listUserProjects(
	userId: string,
): Promise<ProjectSummary[]> {
	const db = await getAuthDb();
	const rows = await db
		.selectFrom("auth_member")
		.innerJoin(
			"auth_organization",
			"auth_organization.id",
			"auth_member.organizationId",
		)
		.select([
			"auth_organization.id as id",
			"auth_organization.name as name",
			"auth_organization.slug as slug",
			"auth_organization.metadata as metadata",
			"auth_member.role as role",
		])
		.where("auth_member.userId", "=", userId)
		.execute();

	return rows
		.map((r) => ({
			id: r.id,
			name: r.name,
			slug: r.slug,
			role: r.role,
			personal: isPersonalMetadata(r.metadata),
		}))
		.sort((a, b) => {
			// Personal Project leads; the rest alphabetical.
			if (a.personal !== b.personal) return a.personal ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
}

/**
 * Members of a Project, each joined to its user identity, newest first — the
 * members table on the settings page. Caller authorization is the page's job
 * (it gates on the caller's own role); this read is scope-only.
 */
export async function listProjectMembers(
	projectId: string,
): Promise<ProjectMemberRow[]> {
	const db = await getAuthDb();
	const rows = await db
		.selectFrom("auth_member")
		.innerJoin("auth_user", "auth_user.id", "auth_member.userId")
		.select([
			"auth_member.id as memberId",
			"auth_member.userId as userId",
			"auth_member.role as role",
			"auth_member.createdAt as createdAt",
			"auth_user.name as name",
			"auth_user.email as email",
		])
		.where("auth_member.organizationId", "=", projectId)
		.orderBy("auth_member.createdAt", "asc")
		.execute();
	return rows.map((r) => ({
		memberId: r.memberId,
		userId: r.userId,
		name: r.name,
		email: r.email,
		role: r.role,
		createdAt: r.createdAt,
	}));
}

/**
 * Pending invitations on a Project — the "invited, not yet accepted" list with
 * its cancel control. Only `pending` rows; accepted/rejected/cancelled drop
 * out (an accepted invite is a member row instead, a cancelled one is noise).
 */
export async function listPendingInvitations(
	projectId: string,
): Promise<ProjectInvitationRow[]> {
	const db = await getAuthDb();
	const rows = await db
		.selectFrom("auth_invitation")
		.select(["id", "email", "role", "expiresAt"])
		.where("organizationId", "=", projectId)
		.where("status", "=", "pending")
		.orderBy("createdAt", "desc")
		.execute();
	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		role: r.role,
		expiresAt: r.expiresAt,
	}));
}

/**
 * Pending, unexpired invitations addressed to `email`, each with its Project
 * name — the accept-invitation surface. Because no invitation email is sent
 * (the org plugin's `sendInvitationEmail` only logs), this in-app list is how
 * an invitee discovers a pending invite. Expired rows are filtered out — they
 * can't be accepted, so showing them is a dead end.
 */
export async function listIncomingInvitations(
	email: string,
	now: Date,
): Promise<IncomingInvitationRow[]> {
	const db = await getAuthDb();
	const rows = await db
		.selectFrom("auth_invitation")
		.innerJoin(
			"auth_organization",
			"auth_organization.id",
			"auth_invitation.organizationId",
		)
		.select([
			"auth_invitation.id as id",
			"auth_invitation.organizationId as organizationId",
			"auth_invitation.role as role",
			"auth_invitation.expiresAt as expiresAt",
			"auth_organization.name as organizationName",
		])
		.where("auth_invitation.email", "=", email.toLowerCase())
		.where("auth_invitation.status", "=", "pending")
		.where("auth_invitation.expiresAt", ">", now)
		.orderBy("auth_invitation.createdAt", "desc")
		.execute();
	return rows.map((r) => ({
		id: r.id,
		organizationId: r.organizationId,
		organizationName: r.organizationName,
		role: r.role,
		expiresAt: r.expiresAt,
	}));
}
