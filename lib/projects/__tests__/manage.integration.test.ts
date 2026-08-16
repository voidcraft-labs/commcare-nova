/**
 * The MCP Project-management writes (`lib/projects/manage.ts`) against real
 * Postgres and a real Better Auth instance — the three contracts unit tests
 * can't prove:
 *
 *   1. An MCP-path invitation is DISCOVERABLE and ACCEPTABLE through the
 *      session path: `createProjectInvitation` lowercases a mixed-case
 *      address so `listIncomingInvitations` (the in-app accept surface — no
 *      invitation email exists) finds it, and Better Auth's own
 *      accept-invitation route turns it into a member row with the invited
 *      role. This is the whole point of the direct-DB insert matching Better
 *      Auth's row shape.
 *   2. A role change SERIALIZES under the exclusive membership gate: a
 *      concurrent raw membership UPDATE (whose statement trigger takes the
 *      exclusive gate) blocks `updateProjectMemberRole` until it commits, and
 *      the manage write then sees the POST-commit actor role — a demoted
 *      actor is refused, never raced past.
 *   3. Hook policy and tool policy agree: the session path (the
 *      `NOVA_ORGANIZATION_HOOKS` mounted on Better Auth) and the MCP path
 *      (`createProjectInvitation`) reject a personal-Project invite and a
 *      non-allowlisted email domain with byte-identical messages, so the two
 *      enforcement sites can't drift apart silently.
 *
 * Harness: `setupPerTestDatabase` per `projectDeletion.integration.test.ts` —
 * Better Auth's schema is migrated through a short-lived pool (its migration
 * adapter holds a connection while the pool lives), the membership-gate
 * trigger migration is installed, and `__setAuthDbForTests` points the manage
 * layer's `getAuthDb()` at the per-test database. Each Better Auth instance
 * runs on its own max-1 pool closed inside the test (the async-leak gate).
 */

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import type { Kysely } from "kysely";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NOVA_ORGANIZATION_HOOKS,
	NOVA_PROJECT_LIFECYCLE_OPTIONS,
} from "@/lib/auth";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { up as installAuthMemberSerialization } from "@/lib/auth/migrations/20260722070000_auth_member_serialization";
import { ac, MEMBERSHIP_LIMIT, PROJECT_ROLES } from "@/lib/auth/projectRoles";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { ORGANIZATION_SCHEMA } from "@/lib/auth-schema-shared";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { PERSONAL_PROJECT_NOT_SHAREABLE_ERROR } from "../invitePolicy";
import {
	createProject,
	createProjectInvitation,
	updateProjectMemberRole,
} from "../manage";
import { listIncomingInvitations } from "../membership";

const TEST_SECRET = "x".repeat(32);
const SESSION_COOKIE = "better-auth.session_token";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "projects_manage_",
});

/** The per-test database as the manage layer's `AuthDatabase` handle. */
function authDb(): Kysely<AuthDatabase> {
	return dbHandle.db as unknown as Kysely<AuthDatabase>;
}

/**
 * The PRODUCTION organization-plugin configuration on a per-test pool: the
 * real access-control roles (so the custom "editor" role is assignable), the
 * real lifecycle options, and — the point of test 3 — the exact
 * `NOVA_ORGANIZATION_HOOKS` functions production mounts.
 */
function createTestAuth(pool: Pool) {
	return betterAuth({
		...authMigrateOptions(pool),
		secret: TEST_SECRET,
		baseURL: "http://localhost:3000",
		plugins: [
			organization({
				ac,
				roles: PROJECT_ROLES,
				creatorRole: "owner",
				allowUserToCreateOrganization: true,
				...NOVA_PROJECT_LIFECYCLE_OPTIONS,
				membershipLimit: MEMBERSHIP_LIMIT,
				teams: { enabled: false },
				schema: ORGANIZATION_SCHEMA,
				organizationHooks: NOVA_ORGANIZATION_HOOKS,
			}),
		],
	});
}

async function migrateAuthSchema(): Promise<void> {
	// Better Auth's migration adapter keeps a Postgres connection open for as
	// long as its supplied pool lives, so schema setup owns a short-lived pool
	// closed before any test work begins.
	const migrationPool = new Pool({ connectionString: dbHandle.uri, max: 1 });
	try {
		const { runMigrations } = await getMigrations(
			authMigrateOptions(migrationPool),
		);
		await runMigrations();
	} finally {
		await migrationPool.end();
	}
}

async function seedUser(
	auth: ReturnType<typeof createTestAuth>,
	id: string,
	name: string,
	email: string,
): Promise<void> {
	const now = new Date();
	const ctx = await auth.$context;
	await ctx.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id,
			name,
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
}

async function seedSession(
	auth: ReturnType<typeof createTestAuth>,
	userId: string,
	token: string,
): Promise<Headers> {
	const now = new Date();
	const ctx = await auth.$context;
	await ctx.adapter.create({
		model: "session",
		data: {
			token,
			userId,
			expiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
		},
	});
	return new Headers({
		cookie: `${SESSION_COOKIE}=${signSessionCookie(token, TEST_SECRET)}`,
	});
}

/**
 * Awaits a call expected to reject and returns its error name + the
 * person-readable message, reading Better Auth's `APIError.body.message` and
 * a plain `Error.message` through the same door — the shape test 3's
 * cross-path byte-equality assertions compare.
 */
async function capturedRejection(
	run: () => Promise<unknown>,
	label: string,
): Promise<{ name: string; message: string }> {
	try {
		await run();
	} catch (error) {
		const name = (error as { name?: unknown }).name;
		const body = (error as { body?: { message?: unknown } }).body;
		const message =
			typeof body?.message === "string"
				? body.message
				: (error as { message?: unknown }).message;
		if (typeof name !== "string" || typeof message !== "string") {
			throw new Error(
				`${label} rejected without a readable name/message: ${String(error)}`,
			);
		}
		return { name, message };
	}
	throw new Error(`${label} unexpectedly succeeded.`);
}

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

/* Mirrors `lib/db/__tests__/projectMembership.integration.test.ts`: polls
 * until any other backend in this database is blocked behind `blockingPid` —
 * the proof the gate contention actually happened before we release it. */
async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<number> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 ORDER BY pid
			 LIMIT 1`,
			[blockingPid],
		);
		const pid = result.rows[0]?.pid;
		if (pid !== undefined) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within two seconds.`,
	);
}

beforeEach(async () => {
	await migrateAuthSchema();
	await installAuthMemberSerialization(dbHandle.db);
	__setAuthDbForTests(authDb());
});

afterEach(() => {
	__setAuthDbForTests(null);
});

describe("MCP Project-management writes", () => {
	it("makes an MCP invitation discoverable in-app and acceptable through Better Auth", async () => {
		const OWNER = "manage-invite-owner";
		const INVITEE = "manage-invite-ada";
		const INVITEE_SESSION = "manage-invite-ada-session";
		const authPool = new Pool({ connectionString: dbHandle.uri, max: 1 });
		try {
			const auth = createTestAuth(authPool);
			await seedUser(auth, OWNER, "Project Owner", "owner@dimagi.com");
			await seedUser(auth, INVITEE, "Ada Lovelace", "ada.lovelace@dimagi.com");
			const inviteeHeaders = await seedSession(auth, INVITEE, INVITEE_SESSION);

			const project = await createProject(OWNER, "ACE Field Team");
			expect(project.name).toBe("ACE Field Team");

			/* The MIXED-CASE address is the load-bearing input: the stored row
			 * must be lowercased or the invitee's discovery list below would
			 * silently miss it. */
			const invite = await createProjectInvitation({
				projectId: project.id,
				actorUserId: OWNER,
				email: "Ada.Lovelace@Dimagi.com",
				role: "editor",
			});
			expect(invite.email).toBe("ada.lovelace@dimagi.com");
			expect(invite.projectName).toBe("ACE Field Team");
			expect(invite.role).toBe("editor");

			/* Discovery — the accept surface queries by the signed-in user's
			 * email, mixed-case or not. */
			const incoming = await listIncomingInvitations(
				"Ada.Lovelace@Dimagi.com",
				new Date(),
			);
			expect(incoming).toHaveLength(1);
			expect(incoming[0]).toMatchObject({
				id: invite.invitationId,
				organizationId: project.id,
				organizationName: "ACE Field Team",
				role: "editor",
			});

			/* Acceptance — Better Auth's own route (with the production hooks
			 * mounted) consumes the direct-DB row and mints the membership. */
			await auth.api.acceptInvitation({
				body: { invitationId: invite.invitationId },
				headers: inviteeHeaders,
			});

			const member = await authDb()
				.selectFrom("auth_member")
				.select(["role"])
				.where("organizationId", "=", project.id)
				.where("userId", "=", INVITEE)
				.executeTakeFirst();
			expect(member?.role).toBe("editor");
			const storedInvite = await authDb()
				.selectFrom("auth_invitation")
				.select(["status"])
				.where("id", "=", invite.invitationId)
				.executeTakeFirst();
			expect(storedInvite?.status).toBe("accepted");
		} finally {
			await authPool.end();
		}
	});

	it("serializes a role change behind concurrent membership DML and honors the post-commit actor role", async () => {
		const ADMIN = "gate-admin";
		const TARGET = "gate-target";
		const PROJECT_ID = "gate-project";
		const TARGET_MEMBER_ID = "gate-target-member";
		const now = new Date();
		await dbHandle.pool.query(
			`INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
			 VALUES ($1, 'Gate Admin', 'gate-admin@dimagi.com', true, $3, $3),
			        ($2, 'Grace Target', 'gate-target@dimagi.com', true, $3, $3)`,
			[ADMIN, TARGET, now],
		);
		await authDb()
			.insertInto("auth_organization")
			.values({
				id: PROJECT_ID,
				name: "Gate Project",
				slug: "gate-project",
				logo: null,
				metadata: null,
				createdAt: now,
			})
			.execute();
		await authDb()
			.insertInto("auth_member")
			.values([
				{
					id: "gate-admin-member",
					organizationId: PROJECT_ID,
					userId: ADMIN,
					role: "admin",
					createdAt: now,
				},
				{
					id: TARGET_MEMBER_ID,
					organizationId: PROJECT_ID,
					userId: TARGET,
					role: "editor",
					createdAt: now,
				},
			])
			.execute();

		/* Positive control: the same call succeeds while the actor is still an
		 * admin, so the race rejection below can only mean the gate worked. */
		await expect(
			updateProjectMemberRole({
				projectId: PROJECT_ID,
				actorUserId: ADMIN,
				memberId: TARGET_MEMBER_ID,
				role: "viewer",
			}),
		).resolves.toMatchObject({
			memberId: TARGET_MEMBER_ID,
			userId: TARGET,
			name: "Grace Target",
			email: "gate-target@dimagi.com",
			previousRole: "editor",
			role: "viewer",
		});

		/* The race: a raw membership UPDATE demoting the ACTOR holds the
		 * exclusive gate (via the statement trigger) in an open transaction.
		 * The manage write must block on the gate — its first statement — and
		 * then read the demoted role, not the stale admin one. */
		const mutator = new Client({ connectionString: dbHandle.uri });
		const observer = new Client({ connectionString: dbHandle.uri });
		await Promise.all([mutator.connect(), observer.connect()]);
		let update:
			| Promise<{ ok: true; error: undefined } | { ok: false; error: unknown }>
			| undefined;
		let committed = false;
		try {
			await mutator.query("BEGIN");
			await mutator.query(
				`UPDATE auth_member
				 SET role = 'viewer'
				 WHERE "userId" = $1 AND "organizationId" = $2`,
				[ADMIN, PROJECT_ID],
			);
			const mutatorPid = await backendPid(mutator);

			update = updateProjectMemberRole({
				projectId: PROJECT_ID,
				actorUserId: ADMIN,
				memberId: TARGET_MEMBER_ID,
				role: "admin",
			}).then(
				() => ({ ok: true as const, error: undefined }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await waitUntilBackendBlockedBy(observer, mutatorPid);
			await mutator.query("COMMIT");
			committed = true;

			const outcome = await update;
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error).toMatchObject({
					name: "ProjectPermissionError",
					message:
						"Your role in this Project is viewer. Only a Project admin or owner can change member roles.",
				});
			}
			const target = await authDb()
				.selectFrom("auth_member")
				.select(["role"])
				.where("id", "=", TARGET_MEMBER_ID)
				.executeTakeFirst();
			expect(target?.role).toBe("viewer");
		} finally {
			/* Release the mutator's gate BEFORE awaiting the manage write: on a
			 * failure earlier in the body the write is still blocked on that
			 * gate, and awaiting it first would deadlock the test. */
			if (!committed) await Promise.allSettled([mutator.query("ROLLBACK")]);
			if (update !== undefined) await Promise.allSettled([update]);
			await Promise.allSettled([observer.query("ROLLBACK")]);
			await Promise.all([mutator.end(), observer.end()]);
		}
	});

	it("rejects a malformed invite address before any transaction work", async () => {
		/* The shape check is a pure input check — it fires before the domain
		 * policy and before the gate-locked transaction, so no Project needs
		 * to exist for the refusal to name the problem. */
		const rejection = await capturedRejection(
			() =>
				createProjectInvitation({
					projectId: "no-such-project",
					actorUserId: "no-such-user",
					email: "not-an-email",
					role: "editor",
				}),
			"malformed-address invite",
		);
		expect(rejection.name).toBe("ProjectManagementError");
		expect(rejection.message).toBe(
			"\"not-an-email\" doesn't look like an email address. Invitations need the invitee's sign-in email, like name@dimagi.com.",
		);
	});

	it("rejects personal-Project and off-domain invites byte-identically on the session and MCP paths", async () => {
		const OWNER = "parity-owner";
		const OWNER_SESSION = "parity-owner-session";
		const PERSONAL_ID = "parity-personal";
		const SHARED_ID = "parity-shared";
		const now = new Date();
		const authPool = new Pool({ connectionString: dbHandle.uri, max: 1 });
		try {
			const auth = createTestAuth(authPool);
			await seedUser(auth, OWNER, "Parity Owner", "parity-owner@dimagi.com");
			const ownerHeaders = await seedSession(auth, OWNER, OWNER_SESSION);
			await authDb()
				.insertInto("auth_organization")
				.values([
					{
						id: PERSONAL_ID,
						name: "Personal Project",
						slug: "parity-personal",
						logo: null,
						/* The provisioner's exact personal marker. */
						metadata: JSON.stringify({ personal: true }),
						createdAt: now,
					},
					{
						id: SHARED_ID,
						name: "Shared Project",
						slug: "parity-shared",
						logo: null,
						metadata: null,
						createdAt: now,
					},
				])
				.execute();
			await authDb()
				.insertInto("auth_member")
				.values([
					{
						id: "parity-personal-owner",
						organizationId: PERSONAL_ID,
						userId: OWNER,
						role: "owner",
						createdAt: now,
					},
					{
						id: "parity-shared-owner",
						organizationId: SHARED_ID,
						userId: OWNER,
						role: "owner",
						createdAt: now,
					},
				])
				.execute();

			/* Personal-Project privacy: both paths refuse with the ONE shared
			 * constant, so each equality below is a byte-identity proof. */
			const sessionPersonal = await capturedRejection(
				() =>
					auth.api.createInvitation({
						body: {
							email: "teammate@dimagi.com",
							role: "editor",
							organizationId: PERSONAL_ID,
						},
						headers: ownerHeaders,
					}),
				"session-path personal-Project invite",
			);
			const mcpPersonal = await capturedRejection(
				() =>
					createProjectInvitation({
						projectId: PERSONAL_ID,
						actorUserId: OWNER,
						email: "teammate@dimagi.com",
						role: "editor",
					}),
				"MCP-path personal-Project invite",
			);
			expect(sessionPersonal.name).toBe("APIError");
			expect(sessionPersonal.message).toBe(
				PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
			);
			expect(mcpPersonal.name).toBe("ProjectManagementError");
			expect(mcpPersonal.message).toBe(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR);

			/* Domain gate: both paths CONSTRUCT their message (Intl.ListFormat
			 * over the allowlist), so the drift lock is cross-path equality. */
			const sessionDomain = await capturedRejection(
				() =>
					auth.api.createInvitation({
						body: {
							email: "friend@gmail.com",
							role: "editor",
							organizationId: SHARED_ID,
						},
						headers: ownerHeaders,
					}),
				"session-path off-domain invite",
			);
			const mcpDomain = await capturedRejection(
				() =>
					createProjectInvitation({
						projectId: SHARED_ID,
						actorUserId: OWNER,
						email: "friend@gmail.com",
						role: "editor",
					}),
				"MCP-path off-domain invite",
			);
			expect(sessionDomain.name).toBe("APIError");
			expect(mcpDomain.name).toBe("ProjectManagementError");
			expect(mcpDomain.message).toBe(sessionDomain.message);
			expect(mcpDomain.message).toMatch(/^Invitations are limited to /);
		} finally {
			await authPool.end();
		}
	});
});
