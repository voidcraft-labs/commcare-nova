// Project-management WRITES for the MCP surface: create a shared Project,
// invite a member, change a member's role. The browser does these through
// Better Auth's organization client, but the MCP is headless and Better Auth's
// invite/role endpoints are session-bound (`requireHeaders: true`), so these
// writers go DIRECTLY through `getAuthDb` — the `lib/auth/provisionProject.ts`
// precedent — and re-state the same policy the `organizationHooks` in
// `lib/auth.ts` enforce on the session path (domain gate, personal-Project
// privacy, audit line). If a rule changes there, it changes here too.
//
// Concurrency: every read-then-write transaction takes the EXCLUSIVE
// Project-membership gate FIRST (`lockProjectMembershipGateExclusive`), before
// any read — the same lock the `auth_member` trigger takes on membership DML —
// so two concurrent writers can't both pass their reads before either writes,
// and membership-dependent readers (shared-gate holders) see whole writes.
// `createProject` takes no explicit gate: it reads nothing first, and its
// member INSERT acquires the gate through the trigger. One known blind spot:
// the trigger fires on `auth_member` DML only, so Better Auth's SESSION-path
// invitation INSERT takes no gate — the duplicate-invite and pending-cap reads
// here are exact against other MCP writers and against membership changes, but
// best-effort against a concurrent session-path invite (`auth_invitation` has
// no unique constraint, so the worst case is a duplicate pending invite, which
// acceptance resolves harmlessly).
//
// Error vocabulary, consumed by `lib/mcp/errors.ts`:
// - `AppAccessError` (`lib/db/appAccess`) for access denials — `not_found` /
//   `not_member` collapse to a not-found result on the wire (a probing key
//   can't distinguish existence).
// - `ProjectPermissionError` when the caller IS a member but their role can't
//   do this — a member legitimately knows the Project exists, so the message
//   is explicit.
// - `ProjectManagementError` for policy rejections (personal Project, already
//   a member, duplicate invite, the pending-invite cap) — person-readable
//   messages passed through to the caller.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthDb } from "@/lib/auth/db";
import { roleCanManageProject, roleIsOwner } from "@/lib/auth/projectRoles";
import { AppAccessError } from "@/lib/db/appAccess";
import { lockProjectMembershipGateExclusive } from "@/lib/db/projectMembershipGate";
import { log } from "@/lib/logger";
import {
	INVITE_ALLOWED_DOMAINS,
	isInvitableEmail,
	isPersonalProjectMetadata,
	PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
} from "./invitePolicy";
import { slugForName } from "./slug";

/**
 * A policy rejection with a person-readable message — the request was
 * understood and refused (personal Project, already a member, duplicate
 * invite, the pending cap). The MCP error classifier passes the message
 * through as `invalid_input`.
 */
export class ProjectManagementError extends Error {
	readonly name = "ProjectManagementError";
}

/**
 * The caller is a member of the Project but their role can't perform this
 * write. Distinct from `AppAccessError` (which collapses to not-found on the
 * wire): a member legitimately knows the Project exists, so the denial is
 * explicit about what's missing.
 */
export class ProjectPermissionError extends Error {
	readonly name = "ProjectPermissionError";
}

/**
 * The roles an invitation or role change may assign. `owner` is excluded (a
 * Project has exactly one owner, minted at creation); `member` is the plugin's
 * legacy default alias and is never offered.
 */
export const ASSIGNABLE_PROJECT_ROLES = ["viewer", "editor", "admin"] as const;
export type AssignableProjectRole = (typeof ASSIGNABLE_PROJECT_ROLES)[number];

/** Better Auth's default invitation lifetime (48 hours) — matched here so an
 *  MCP-created invite expires exactly like a session-created one. */
const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

/** Better Auth's default per-organization pending-invitation cap, matched at
 *  create time so the MCP path can't outgrow what the session path allows. */
const PENDING_INVITATION_LIMIT = 100;

/** Display-name bound — matches the Project switcher's input `maxLength`. */
const PROJECT_NAME_MAX_LENGTH = 64;

/** Email-shape admission for invitations. Better Auth's session-path invite
 *  endpoint validates the address shape in its request schema; this is the
 *  headless path's equivalent, so a typo'd address is refused instead of
 *  stored as an invite no sign-in will ever match. */
const INVITE_EMAIL_SHAPE = z.email();

export interface CreatedProject {
	id: string;
	name: string;
	slug: string;
}

export interface CreatedInvitation {
	invitationId: string;
	projectId: string;
	projectName: string;
	/** The stored (lowercased) invite address — the key the invitee's in-app
	 *  discovery list matches on. */
	email: string;
	role: AssignableProjectRole;
	expiresAt: Date;
}

export interface UpdatedMemberRole {
	memberId: string;
	userId: string;
	name: string;
	email: string;
	previousRole: string;
	role: AssignableProjectRole;
}

function assertAssignableRole(
	role: string,
): asserts role is AssignableProjectRole {
	if (!(ASSIGNABLE_PROJECT_ROLES as readonly string[]).includes(role)) {
		throw new ProjectManagementError(
			`"${role}" isn't an assignable role. Pick viewer, editor, or admin.`,
		);
	}
}

/**
 * Creates a shared Project owned by `userId`: the organization row plus the
 * owner membership in ONE transaction (mirroring `ensurePersonalProject`, so
 * a partial failure can't leave an org with no members). Metadata stays NULL —
 * this is never a personal Project. Retries once with a fresh slug suffix on a
 * slug unique-violation; a second collision surfaces.
 */
export async function createProject(
	userId: string,
	name: string,
): Promise<CreatedProject> {
	const trimmed = name.trim();
	if (trimmed === "") {
		throw new ProjectManagementError(
			"Project names can't be empty. Give the Project a short descriptive name.",
		);
	}
	if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
		throw new ProjectManagementError(
			`Project names are limited to ${PROJECT_NAME_MAX_LENGTH} characters.`,
		);
	}

	const db = await getAuthDb();
	const insertOnce = async (): Promise<CreatedProject> => {
		const id = randomUUID();
		const slug = slugForName(trimmed);
		await db.transaction().execute(async (tx) => {
			await tx
				.insertInto("auth_organization")
				.values({
					id,
					name: trimmed,
					slug,
					logo: null,
					metadata: null,
					createdAt: new Date(),
				})
				.execute();
			await tx
				.insertInto("auth_member")
				.values({
					id: randomUUID(),
					organizationId: id,
					userId,
					role: "owner",
					createdAt: new Date(),
				})
				.execute();
		});
		return { id, name: trimmed, slug };
	};

	try {
		return await insertOnce();
	} catch (err) {
		// The slug carries a random suffix, so a unique-violation is a ~1-in-16M
		// collision (or a concurrent same-name create); one fresh suffix settles
		// it. Anything else — including a second collision — surfaces.
		if ((err as { code?: unknown })?.code !== "23505") throw err;
		return await insertOnce();
	}
}

export interface CreateProjectInvitationInput {
	projectId: string;
	actorUserId: string;
	email: string;
	role: string;
}

/**
 * Invites `email` to a shared Project. The pure input checks (assignable
 * role, email shape, the domain gate) run first, outside any lock; then one
 * gate-locked transaction: the exclusive membership gate first, then the
 * reads (Project existence, the actor's membership + manage role, the
 * personal-Project flag, already-a-member, duplicate pending invite, the
 * pending cap), then the
 * insert. The stored email is LOWERCASED — the invitee's in-app discovery list
 * (`listIncomingInvitations`) matches on the lowercased address, so a
 * mixed-case insert would be silently undiscoverable. No email is sent by
 * design; the invitee finds the invite in-app on their next sign-in.
 */
export async function createProjectInvitation(
	input: CreateProjectInvitationInput,
): Promise<CreatedInvitation> {
	const { projectId, actorUserId } = input;
	assertAssignableRole(input.role);
	const role = input.role;
	const email = input.email.trim().toLowerCase();

	/* Pure input checks run BEFORE the gate-locked transaction — they depend
	 * only on the arguments, so rejecting here keeps malformed input from
	 * ever holding the exclusive membership gate. Format first (an address
	 * that isn't an email can't be invited anywhere), then the domain policy. */
	if (!INVITE_EMAIL_SHAPE.safeParse(email).success) {
		throw new ProjectManagementError(
			`"${email}" doesn't look like an email address. Invitations need the invitee's sign-in email, like name@dimagi.com.`,
		);
	}
	if (!isInvitableEmail(email)) {
		throw new ProjectManagementError(
			`Invitations are limited to ${new Intl.ListFormat("en").format(INVITE_ALLOWED_DOMAINS)} email addresses.`,
		);
	}

	const db = await getAuthDb();
	const created = await db.transaction().execute(async (tx) => {
		await lockProjectMembershipGateExclusive(tx);
		const now = new Date();

		const org = await tx
			.selectFrom("auth_organization")
			.select(["id", "name", "metadata"])
			.where("id", "=", projectId)
			.executeTakeFirst();
		if (org === undefined) throw new AppAccessError("not_found");

		const members = await tx
			.selectFrom("auth_member")
			.innerJoin("auth_user", "auth_user.id", "auth_member.userId")
			.select([
				"auth_member.userId as userId",
				"auth_member.role as role",
				"auth_user.email as email",
			])
			.where("auth_member.organizationId", "=", projectId)
			.execute();

		const actor = members.find((m) => m.userId === actorUserId);
		if (actor === undefined) throw new AppAccessError("not_member");
		if (!roleCanManageProject(actor.role)) {
			throw new ProjectPermissionError(
				`Your role in this Project is ${actor.role}. Only a Project admin or owner can invite members.`,
			);
		}
		if (isPersonalProjectMetadata(org.metadata)) {
			throw new ProjectManagementError(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR);
		}

		const existingMember = members.find((m) => m.email.toLowerCase() === email);
		if (existingMember !== undefined) {
			throw new ProjectManagementError(
				`${email} is already a member of this Project with the ${existingMember.role} role. Use update_member_role to change it.`,
			);
		}

		const pending = await tx
			.selectFrom("auth_invitation")
			.select(["email", "role"])
			.where("organizationId", "=", projectId)
			.where("status", "=", "pending")
			.where("expiresAt", ">", now)
			.execute();
		const duplicate = pending.find((p) => p.email.toLowerCase() === email);
		if (duplicate !== undefined) {
			throw new ProjectManagementError(
				`${email} already has a pending invitation to this Project (role: ${duplicate.role ?? "viewer"}). They can accept it in commcare nova the next time they sign in.`,
			);
		}
		if (pending.length >= PENDING_INVITATION_LIMIT) {
			throw new ProjectManagementError(
				`This Project already has ${PENDING_INVITATION_LIMIT} pending invitations, which is the limit. Ask invitees to accept, or cancel stale invitations in Project settings, then try again.`,
			);
		}

		const invitationId = randomUUID();
		const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
		await tx
			.insertInto("auth_invitation")
			.values({
				id: invitationId,
				organizationId: projectId,
				email,
				role,
				status: "pending",
				inviterId: actorUserId,
				expiresAt,
				createdAt: now,
			})
			.execute();

		return {
			invitationId,
			projectId,
			projectName: org.name,
			email,
			role,
			expiresAt,
		};
	});

	// The audit twin of `afterCreateInvitation` in lib/auth.ts — the session
	// path's only invitation side effect, mirrored so both paths leave the same
	// trace.
	log.info("[projects] organization invitation created", {
		organizationId: created.projectId,
		email: created.email,
		inviterId: actorUserId,
	});
	return created;
}

export interface UpdateProjectMemberRoleInput {
	projectId: string;
	actorUserId: string;
	memberId: string;
	role: string;
}

/**
 * Changes a member's role in a shared Project. One gate-locked transaction:
 * the exclusive membership gate first, then the reads (Project existence, the
 * actor's membership + manage role, the personal-Project flag, the target
 * row), then the UPDATE. The owner's role is never changeable here — the UI
 * hides owner rows the same way, and it moots last-owner hazards. The stored
 * role may be comma-joined (Better Auth allows multi-role rows), so the owner
 * check splits rather than string-compares. Setting the role a member already
 * holds is a no-op success.
 */
export async function updateProjectMemberRole(
	input: UpdateProjectMemberRoleInput,
): Promise<UpdatedMemberRole> {
	const { projectId, actorUserId, memberId } = input;
	assertAssignableRole(input.role);
	const role = input.role;

	const db = await getAuthDb();
	return await db.transaction().execute(async (tx) => {
		await lockProjectMembershipGateExclusive(tx);

		const org = await tx
			.selectFrom("auth_organization")
			.select(["id", "metadata"])
			.where("id", "=", projectId)
			.executeTakeFirst();
		if (org === undefined) throw new AppAccessError("not_found");

		const actor = await tx
			.selectFrom("auth_member")
			.select(["role"])
			.where("organizationId", "=", projectId)
			.where("userId", "=", actorUserId)
			.executeTakeFirst();
		if (actor === undefined) throw new AppAccessError("not_member");
		if (!roleCanManageProject(actor.role)) {
			throw new ProjectPermissionError(
				`Your role in this Project is ${actor.role}. Only a Project admin or owner can change member roles.`,
			);
		}
		if (isPersonalProjectMetadata(org.metadata)) {
			throw new ProjectManagementError(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR);
		}

		const target = await tx
			.selectFrom("auth_member")
			.innerJoin("auth_user", "auth_user.id", "auth_member.userId")
			.select([
				"auth_member.id as memberId",
				"auth_member.userId as userId",
				"auth_member.role as role",
				"auth_user.name as name",
				"auth_user.email as email",
			])
			.where("auth_member.organizationId", "=", projectId)
			.where("auth_member.id", "=", memberId)
			.executeTakeFirst();
		if (target === undefined) {
			throw new ProjectManagementError(
				`No member with id "${memberId}" in this Project. Use list_members for current member ids.`,
			);
		}
		if (roleIsOwner(target.role)) {
			throw new ProjectManagementError(
				"The Project owner's role can't be changed.",
			);
		}

		if (target.role !== role) {
			await tx
				.updateTable("auth_member")
				.set({ role })
				.where("id", "=", memberId)
				.execute();
		}

		return {
			memberId: target.memberId,
			userId: target.userId,
			name: target.name,
			email: target.email,
			previousRole: target.role,
			role,
		};
	});
}
