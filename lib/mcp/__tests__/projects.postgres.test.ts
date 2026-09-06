/** Project tools through actual SDK dispatch, migrated membership tables and
 * Better Auth acceptance. No service or authorization methods are replaced. */
import type { Client } from "@modelcontextprotocol/client";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { Pool } from "pg";
import { expect, it } from "vitest";
import {
	NOVA_ORGANIZATION_HOOKS,
	NOVA_PROJECT_LIFECYCLE_OPTIONS,
} from "@/lib/auth";
import { getAuthDb } from "@/lib/auth/db";
import { ac, MEMBERSHIP_LIMIT, PROJECT_ROLES } from "@/lib/auth/projectRoles";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { ORGANIZATION_SCHEMA } from "@/lib/auth-schema-shared";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { listIncomingInvitations } from "@/lib/projects/membership";
import { registerCreateProject } from "../tools/createProject";
import { registerInviteMember } from "../tools/inviteMember";
import { registerListMembers } from "../tools/listMembers";
import { registerListProjects } from "../tools/listProjects";
import { registerUpdateMemberRole } from "../tools/updateMemberRole";
import { withMcpClient } from "./client";
import { whileBlocked } from "./postgresBarrier";
import { resultText } from "./promptClient";

const h = setupAppStateTestDb("mcp_projects_", { authSchema: "migrated" });
const ACTOR = "ada";
const PROJECT = "clinic";
const scopes = [
	"nova.read",
	"nova.write",
	"nova.projects.read",
	"nova.projects.write",
];
function asUser<T>(
	userId: string,
	run: (client: Client) => Promise<T>,
	granted = scopes,
) {
	return withMcpClient((server) => {
		for (const tool of [
			registerCreateProject,
			registerInviteMember,
			registerListMembers,
			registerListProjects,
			registerUpdateMemberRole,
		])
			tool(server, { userId, scopes: granted, authKind: "oauth" });
	}, run);
}
async function call(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
) {
	return JSON.parse(
		resultText(await client.callTool({ name, arguments: args })),
	);
}
async function refusal(
	client: Client,
	name: string,
	args: Record<string, unknown>,
	kind: string,
	message?: string,
) {
	const result = await client.callTool({ name, arguments: args });
	expect(result.isError).toBe(true);
	expect(result.content).toHaveLength(1);
	const text = result.content[0];
	if (text.type !== "text") throw new Error("Expected a text refusal");
	const body = JSON.parse(text.text);
	expect(body.error_type).toBe(kind);
	if (message !== undefined) expect(body.message).toBe(message);
	return body;
}
async function seed(
	user = ACTOR,
	project = PROJECT,
	role: "owner" | "admin" | "editor" | "viewer" = "owner",
) {
	await h.seedProjectMember(user, project, role);
	const db = await getAuthDb();
	await db
		.updateTable("auth_user")
		.set({ email: `${user}@dimagi.com`, name: user })
		.where("id", "=", user)
		.execute();
	return (
		await db
			.selectFrom("auth_member")
			.selectAll()
			.where("userId", "=", user)
			.where("organizationId", "=", project)
			.executeTakeFirstOrThrow()
	).id;
}
async function snapshot() {
	const db = await getAuthDb();
	return {
		projects: await db
			.selectFrom("auth_organization")
			.selectAll()
			.orderBy("id")
			.execute(),
		members: await db
			.selectFrom("auth_member")
			.selectAll()
			.orderBy("id")
			.execute(),
		invitations: await db
			.selectFrom("auth_invitation")
			.selectAll()
			.orderBy("id")
			.execute(),
	};
}
function createTestAuth(pool: Pool) {
	return betterAuth({
		...authMigrateOptions(pool),
		secret: "x".repeat(32),
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
async function withSession<T>(
	userId: string,
	run: (
		auth: ReturnType<typeof createTestAuth>,
		headers: Headers,
	) => Promise<T>,
) {
	const pool = new Pool({ connectionString: h.uri(), max: 1 });
	try {
		const auth = createTestAuth(pool);
		const now = new Date();
		const token = crypto.randomUUID();
		await (await auth.$context).adapter.create({
			model: "session",
			data: {
				token,
				userId,
				expiresAt: new Date(now.getTime() + 60_000),
				createdAt: now,
				updatedAt: now,
			},
		});
		return await run(
			auth,
			new Headers({
				cookie: `better-auth.session_token=${signSessionCookie(token, "x".repeat(32))}`,
			}),
		);
	} finally {
		await pool.end();
	}
}

it("creates atomic owner memberships, trims names and lists only current memberships with personal first", async () => {
	await seed();
	await seed("outsider", "foreign");
	await seed(ACTOR, "z-personal");
	const db = await getAuthDb();
	await db
		.updateTable("auth_organization")
		.set({ metadata: '{"personal":true}' })
		.where("id", "=", "z-personal")
		.execute();
	await asUser(ACTOR, async (client) => {
		const first = await call(client, "create_project", {
			name: "  Alpha team  ",
		});
		const second = await call(client, "create_project", { name: "Alpha team" });
		expect(first).toEqual({
			project_id: expect.any(String),
			name: "Alpha team",
			slug: expect.stringMatching(/^alpha-team-[0-9a-f]{6}$/),
			role: "owner",
		});
		expect(second.project_id).not.toBe(first.project_id);
		expect(second.slug).not.toBe(first.slug);
		for (const created of [first, second]) {
			expect(
				await db
					.selectFrom("auth_organization")
					.select(["id", "name", "slug", "metadata"])
					.where("id", "=", created.project_id)
					.executeTakeFirst(),
			).toEqual({
				id: created.project_id,
				name: created.name,
				slug: created.slug,
				metadata: null,
			});
			expect(
				await db
					.selectFrom("auth_member")
					.select(["userId", "role"])
					.where("organizationId", "=", created.project_id)
					.execute(),
			).toEqual([{ userId: ACTOR, role: "owner" }]);
		}
		// Avoid assigning order to equal display names; their complete rows must both occur.
		const projects = (await call(client, "list_projects")).projects;
		expect(projects[0]).toEqual({
			project_id: "z-personal",
			name: "z-personal",
			slug: "z-personal",
			role: "owner",
			personal: true,
		});
		expect(projects.slice(1, 3)).toEqual(
			expect.arrayContaining(
				[first, second].map((p) => ({ ...p, personal: false })),
			),
		);
		expect(projects[3]).toEqual({
			project_id: PROJECT,
			name: PROJECT,
			slug: PROJECT,
			role: "owner",
			personal: false,
		});
		expect(projects).toHaveLength(4);
		await db
			.deleteFrom("auth_member")
			.where("organizationId", "=", PROJECT)
			.where("userId", "=", ACTOR)
			.execute();
		expect(
			(await call(client, "list_projects")).projects.map(
				(p: { project_id: string }) => p.project_id,
			),
		).not.toContain(PROJECT);
	});
	await asUser(
		"no-membership",
		async (client) =>
			expect(await call(client, "list_projects")).toEqual({ projects: [] }),
		["nova.read", "nova.write"],
	);
});

it("rolls back the Project when owner insertion fails, then permits a clean retry", async () => {
	await seed();
	const before = await snapshot();
	await h
		.pool()
		.query(`CREATE FUNCTION reject_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private owner insert diagnostic'; END $$;
 CREATE TRIGGER reject_owner BEFORE INSERT ON auth_member FOR EACH ROW EXECUTE FUNCTION reject_owner()`);
	await asUser(ACTOR, async (client) => {
		const error = await refusal(
			client,
			"create_project",
			{ name: "New team" },
			"internal",
			"Something went wrong during generation.",
		);
		expect(JSON.stringify(error)).not.toContain("private owner");
		expect(await snapshot()).toEqual(before);
		await h.pool().query("DROP TRIGGER reject_owner ON auth_member");
		expect(
			(await call(client, "create_project", { name: "New team" })).role,
		).toBe("owner");
	});
});

it("issues a discoverable invitation, accepts it through Better Auth, changes its returned member handle and makes repeats write-free", async () => {
	await seed();
	await seed("grace", "grace-personal");
	const db = await getAuthDb();
	await asUser(ACTOR, async (client) => {
		const invitation = await call(client, "invite_member", {
			project_id: PROJECT,
			email: "  Grace@Dimagi.com  ",
			role: "editor",
		});
		const stored = await db
			.selectFrom("auth_invitation")
			.selectAll()
			.where("id", "=", invitation.invitation_id)
			.executeTakeFirstOrThrow();
		expect(invitation).toEqual({
			invitation_id: stored.id,
			project_id: PROJECT,
			project_name: PROJECT,
			email: "grace@dimagi.com",
			role: "editor",
			expires_at: stored.expiresAt.toISOString(),
			note: "No email is sent. grace@dimagi.com will see this invitation in commcare nova the next time they sign in, and can accept it there.",
		});
		expect(stored).toMatchObject({
			organizationId: PROJECT,
			email: "grace@dimagi.com",
			role: "editor",
			status: "pending",
			inviterId: ACTOR,
		});
		expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
			172_800_000,
		);
		expect(
			await listIncomingInvitations("Grace@Dimagi.com", new Date()),
		).toEqual([
			{
				id: stored.id,
				organizationId: PROJECT,
				organizationName: PROJECT,
				role: "editor",
				expiresAt: stored.expiresAt,
			},
		]);
		await withSession("grace", async (auth, headers) => {
			await auth.api.acceptInvitation({
				body: { invitationId: stored.id },
				headers,
			});
		});
		const members = await call(client, "list_members", { project_id: PROJECT });
		expect(members.pending_invitations).toEqual([]);
		expect(
			await listIncomingInvitations("grace@dimagi.com", new Date()),
		).toEqual([]);
		expect(
			(
				await db
					.selectFrom("auth_invitation")
					.select("status")
					.where("id", "=", stored.id)
					.executeTakeFirstOrThrow()
			).status,
		).toBe("accepted");
		const member = members.members.find(
			(m: { user_id: string }) => m.user_id === "grace",
		);
		expect(member).toEqual({
			member_id: expect.any(String),
			user_id: "grace",
			name: "grace",
			email: "grace@dimagi.com",
			role: "editor",
			joined_at: expect.any(String),
		});
		expect(
			await call(client, "update_member_role", {
				project_id: PROJECT,
				member_id: member.member_id,
				role: "admin",
			}),
		).toEqual({
			project_id: PROJECT,
			member_id: member.member_id,
			user_id: "grace",
			name: "grace",
			email: "grace@dimagi.com",
			previous_role: "editor",
			role: "admin",
		});
		expect(
			(
				await db
					.selectFrom("auth_member")
					.select("role")
					.where("id", "=", member.member_id)
					.executeTakeFirstOrThrow()
			).role,
		).toBe("admin");
		await h
			.pool()
			.query(
				`CREATE FUNCTION reject_role_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'a no-op must not update'; END $$; CREATE TRIGGER reject_role_update BEFORE UPDATE ON auth_member FOR EACH STATEMENT EXECUTE FUNCTION reject_role_update()`,
			);
		expect(
			(
				await call(client, "update_member_role", {
					project_id: PROJECT,
					member_id: member.member_id,
					role: "admin",
				})
			).previous_role,
		).toBe("admin");
	});
});

it("filters invitations by Project, status and actual expiry while preserving member and legacy invitation projections", async () => {
	const owner = await seed();
	const viewer = await seed("grace", PROJECT, "viewer");
	await seed("outsider", "foreign");
	const db = await getAuthDb();
	const joined = new Date("2026-01-01T00:00:00Z");
	await db
		.updateTable("auth_member")
		.set({ createdAt: joined })
		.where("id", "=", owner)
		.execute();
	await db
		.updateTable("auth_member")
		.set({ createdAt: new Date("2026-01-02T00:00:00Z") })
		.where("id", "=", viewer)
		.execute();
	const now = Date.now();
	const rows = [
		{
			id: "legacy",
			organizationId: PROJECT,
			role: null,
			status: "pending",
			delta: 60_000,
		},
		{
			id: "expired",
			organizationId: PROJECT,
			role: "editor",
			status: "pending",
			delta: -60_000,
		},
		{
			id: "accepted",
			organizationId: PROJECT,
			role: "admin",
			status: "accepted",
			delta: 60_000,
		},
		{
			id: "cancelled",
			organizationId: PROJECT,
			role: "viewer",
			status: "canceled",
			delta: 60_000,
		},
		{
			id: "foreign",
			organizationId: "foreign",
			role: "viewer",
			status: "pending",
			delta: 60_000,
		},
	];
	await db
		.insertInto("auth_invitation")
		.values(
			rows.map(({ delta, ...r }) => ({
				...r,
				email: `${r.id}@dimagi.com`,
				inviterId: ACTOR,
				createdAt: new Date(now),
				expiresAt: new Date(now + delta),
			})),
		)
		.execute();
	await asUser("grace", async (client) => {
		expect(await call(client, "list_members", { project_id: PROJECT })).toEqual(
			{
				project_id: PROJECT,
				members: [
					{
						member_id: owner,
						user_id: ACTOR,
						name: ACTOR,
						email: "ada@dimagi.com",
						role: "owner",
						joined_at: joined.toISOString(),
					},
					{
						member_id: viewer,
						user_id: "grace",
						name: "grace",
						email: "grace@dimagi.com",
						role: "viewer",
						joined_at: "2026-01-02T00:00:00.000Z",
					},
				],
				pending_invitations: [
					{
						invitation_id: "legacy",
						email: "legacy@dimagi.com",
						role: "viewer",
						expires_at: new Date(now + 60_000).toISOString(),
					},
				],
			},
		);
	});
});

it("enforces orthogonal scopes before Project existence and leaves all stored rows untouched", async () => {
	const member = await seed();
	const before = await snapshot();
	await asUser(
		ACTOR,
		async (client) => {
			expect((await call(client, "list_projects")).projects).toHaveLength(1);
			for (const project_id of [PROJECT, "missing"]) {
				for (const [name, args, required] of [
					["list_members", { project_id }, "nova.projects.read"],
					[
						"invite_member",
						{ project_id, email: "grace@dimagi.com", role: "editor" },
						"nova.projects.write",
					],
					[
						"update_member_role",
						{ project_id, member_id: member, role: "viewer" },
						"nova.projects.write",
					],
				] as const) {
					const body = await refusal(client, name, args, "scope_missing");
					expect(body).toMatchObject({ required_scope: required, project_id });
				}
			}
			expect(
				(
					await refusal(
						client,
						"create_project",
						{ name: "Denied" },
						"scope_missing",
					)
				).required_scope,
			).toBe("nova.projects.write");
		},
		["nova.read", "nova.write"],
	);
	expect(await snapshot()).toEqual(before);
});

it("collapses foreign and absent Projects, denies low roles, and refuses owner and cross-Project member handles", async () => {
	const owner = await seed();
	const foreignMember = await seed("outsider", "foreign");
	await seed("viewer", PROJECT, "viewer");
	await seed("editor", PROJECT, "editor");
	const before = await snapshot();
	await asUser(ACTOR, async (client) => {
		for (const project_id of ["foreign", "missing"]) {
			for (const [name, args] of [
				["list_members", { project_id }],
				[
					"invite_member",
					{ project_id, email: "grace@dimagi.com", role: "editor" },
				],
				[
					"update_member_role",
					{ project_id, member_id: foreignMember, role: "viewer" },
				],
			] as const)
				expect(
					await refusal(client, name, args, "not_found", "Project not found."),
				).toEqual({
					error_type: "not_found",
					message: "Project not found.",
					project_id,
				});
		}
		await refusal(
			client,
			"update_member_role",
			{ project_id: PROJECT, member_id: owner, role: "viewer" },
			"invalid_input",
			"The Project owner's role can't be changed.",
		);
		await refusal(
			client,
			"update_member_role",
			{ project_id: PROJECT, member_id: foreignMember, role: "viewer" },
			"invalid_input",
			`No member with id "${foreignMember}" in this Project. Use list_members for current member ids.`,
		);
	});
	for (const role of ["viewer", "editor"])
		await asUser(role, async (client) => {
			await refusal(
				client,
				"invite_member",
				{ project_id: PROJECT, email: "grace@dimagi.com", role: "editor" },
				"permission_denied",
				`Your role in this Project is ${role}. Only a Project admin or owner can invite members.`,
			);
			await refusal(
				client,
				"update_member_role",
				{ project_id: PROJECT, member_id: owner, role: "viewer" },
				"permission_denied",
				`Your role in this Project is ${role}. Only a Project admin or owner can change member roles.`,
			);
		});
	expect(await snapshot()).toEqual(before);
});

it("rejects malformed inputs and policy violations without writes, then allows an expired invite to be replaced", async () => {
	const owner = await seed();
	await seed(ACTOR, "personal");
	const db = await getAuthDb();
	await db
		.updateTable("auth_organization")
		.set({ metadata: '{"personal":true}' })
		.where("id", "=", "personal")
		.execute();
	await asUser(ACTOR, async (client) => {
		const before = await snapshot();
		for (const name of ["   ", "x".repeat(65)])
			await refusal(client, "create_project", { name }, "invalid_input");
		for (const email of ["not-email", "grace@gmail.com", "ada@dimagi.com"])
			await refusal(
				client,
				"invite_member",
				{ project_id: PROJECT, email, role: "editor" },
				"invalid_input",
			);
		const privateCopy =
			"Your personal Project is private and can't be shared. Create or switch to a shared Project to build apps with teammates.";
		await refusal(
			client,
			"invite_member",
			{ project_id: "personal", email: "grace@dimagi.com", role: "editor" },
			"invalid_input",
			privateCopy,
		);
		await refusal(
			client,
			"update_member_role",
			{ project_id: "personal", member_id: owner, role: "viewer" },
			"invalid_input",
			privateCopy,
		);
		for (const [name, args] of [
			["create_project", { name: "Allowed", actorUserId: "outsider" }],
			["list_members", { project_id: "" }],
			[
				"invite_member",
				{ project_id: PROJECT, email: "grace@dimagi.com", role: "owner" },
			],
			[
				"update_member_role",
				{ project_id: PROJECT, member_id: owner, role: "member" },
			],
		] as const) {
			const result = await client.callTool({ name, arguments: args });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain(
				"Input validation error",
			);
		}
		expect(await snapshot()).toEqual(before);
		const invite = await call(client, "invite_member", {
			project_id: PROJECT,
			email: "grace@dimagi.com",
			role: "editor",
		});
		await refusal(
			client,
			"invite_member",
			{ project_id: PROJECT, email: "GRACE@dimagi.com", role: "admin" },
			"invalid_input",
			"grace@dimagi.com already has a pending invitation to this Project (role: editor). They can accept it in commcare nova the next time they sign in.",
		);
		expect(
			await db.selectFrom("auth_invitation").select("id").execute(),
		).toEqual([{ id: invite.invitation_id }]);
		await db
			.updateTable("auth_invitation")
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where("id", "=", invite.invitation_id)
			.execute();
		const fresh = await call(client, "invite_member", {
			project_id: PROJECT,
			email: "grace@dimagi.com",
			role: "admin",
		});
		expect(fresh.invitation_id).not.toBe(invite.invitation_id);
		expect(
			(await call(client, "list_members", { project_id: PROJECT }))
				.pending_invitations,
		).toEqual([
			{
				invitation_id: fresh.invitation_id,
				email: "grace@dimagi.com",
				role: "admin",
				expires_at: fresh.expires_at,
			},
		]);
	});
});

it("waits behind a native membership change and rejects the demoted actor after that transaction commits", async () => {
	await seed(ACTOR, PROJECT, "admin");
	const target = await seed("grace", PROJECT, "editor");
	const db = await getAuthDb();
	await asUser(ACTOR, async (client) => {
		const args = { project_id: PROJECT, member_id: target, role: "viewer" };
		expect((await call(client, "update_member_role", args)).role).toBe(
			"viewer",
		);
		const result = await whileBlocked(
			h,
			(pg) =>
				pg.query(
					'UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = $3',
					["viewer", ACTOR, PROJECT],
				),
			() =>
				client.callTool({
					name: "update_member_role",
					arguments: { ...args, role: "admin" },
				}),
			async (settled, pg) => {
				expect(settled).toBe(false);
				expect(
					(
						await pg.query("SELECT role FROM auth_member WHERE id = $1", [
							target,
						])
					).rows,
				).toEqual([{ role: "viewer" }]);
				await pg.query("COMMIT");
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					error_type: "permission_denied",
					message:
						"Your role in this Project is viewer. Only a Project admin or owner can change member roles.",
					project_id: PROJECT,
				}),
			},
		]);
		expect(
			(
				await db
					.selectFrom("auth_member")
					.select("role")
					.where("id", "=", target)
					.executeTakeFirstOrThrow()
			).role,
		).toBe("viewer");
	});
});

it("counts only live pending invitations toward the 100-invitation cap and frees a slot on cancellation", async () => {
	await seed();
	await seed(ACTOR, "other");
	const db = await getAuthDb();
	const now = Date.now();
	await db
		.insertInto("auth_invitation")
		.values([
			...Array.from({ length: 99 }, (_, i) => ({
				id: `pending-${i}`,
				organizationId: PROJECT,
				email: `pending-${i}@dimagi.com`,
				role: "viewer",
				status: "pending",
				inviterId: ACTOR,
				createdAt: new Date(now),
				expiresAt: new Date(now + 60_000),
			})),
			...[
				{
					id: "old",
					organizationId: PROJECT,
					status: "pending",
					delta: -60_000,
				},
				{
					id: "accepted",
					organizationId: PROJECT,
					status: "accepted",
					delta: 60_000,
				},
				{
					id: "other",
					organizationId: "other",
					status: "pending",
					delta: 60_000,
				},
			].map(({ delta, ...r }) => ({
				...r,
				email: `${r.id}@dimagi.com`,
				role: "viewer",
				inviterId: ACTOR,
				createdAt: new Date(now),
				expiresAt: new Date(now + delta),
			})),
		])
		.execute();
	await asUser(ACTOR, async (client) => {
		const args = {
			project_id: PROJECT,
			email: "hundredth@dimagi.com",
			role: "viewer",
		};
		await call(client, "invite_member", args);
		const before = await snapshot();
		await refusal(
			client,
			"invite_member",
			{ ...args, email: "next@dimagi.com" },
			"invalid_input",
			"This Project already has 100 pending invitations, which is the limit. Ask invitees to accept, or cancel stale invitations in Project settings, then try again.",
		);
		expect(await snapshot()).toEqual(before);
		await db
			.updateTable("auth_invitation")
			.set({ status: "canceled" })
			.where("id", "=", "pending-0")
			.execute();
		await call(client, "invite_member", { ...args, email: "next@dimagi.com" });
		expect(
			(await call(client, "list_members", { project_id: PROJECT }))
				.pending_invitations,
		).toHaveLength(100);
	});
});

it("enforces the same privacy and domain policy through both authenticated session and MCP requests", async () => {
	await seed();
	await seed(ACTOR, "personal");
	const db = await getAuthDb();
	await db
		.updateTable("auth_organization")
		.set({ metadata: '{"personal":true}' })
		.where("id", "=", "personal")
		.execute();
	const before = await snapshot();
	await withSession(ACTOR, async (auth, headers) => {
		await asUser(ACTOR, async (client) => {
			for (const [project_id, email, message] of [
				[
					"personal",
					"grace@dimagi.com",
					"Your personal Project is private and can't be shared. Create or switch to a shared Project to build apps with teammates.",
				],
				[
					PROJECT,
					"friend@gmail.com",
					"Invitations are limited to dimagi.com, dimagi-ai.com, and dimagi-associate.com email addresses.",
				],
			] as const) {
				await expect(
					auth.api.createInvitation({
						body: { organizationId: project_id, email, role: "editor" },
						headers,
					}),
				).rejects.toMatchObject({ name: "APIError", body: { message } });
				await refusal(
					client,
					"invite_member",
					{ project_id, email, role: "editor" },
					"invalid_input",
					message,
				);
			}
		});
	});
	expect(await snapshot()).toEqual(before);
});
