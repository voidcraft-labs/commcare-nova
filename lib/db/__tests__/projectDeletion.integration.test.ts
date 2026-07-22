/**
 * Better Auth's native Project-deletion guard against the real Postgres adapter.
 * The important ordering contract is that the plugin refuses deletion before it
 * reads or clears the active Project on the session.
 */
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { NOVA_PROJECT_LIFECYCLE_OPTIONS } from "@/lib/auth";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { ORGANIZATION_SCHEMA } from "@/lib/auth-schema-shared";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const TEST_SECRET = "x".repeat(32);
const TEST_USER_ID = "project-delete-user";
const TEST_PROJECT_ID = "project-delete-project";
const TEST_SESSION_TOKEN = "project-delete-session-token";
const SESSION_COOKIE = "better-auth.session_token";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "auth_project_delete_",
});

function createTestAuth(pool: typeof dbHandle.pool) {
	const baseOptions = authMigrateOptions(pool);
	return betterAuth({
		...baseOptions,
		secret: TEST_SECRET,
		baseURL: "http://localhost:3000",
		plugins: [
			organization({
				...NOVA_PROJECT_LIFECYCLE_OPTIONS,
				teams: { enabled: false },
				schema: ORGANIZATION_SCHEMA,
			}),
		],
	});
}

async function migrateAuthSchema() {
	// Better Auth's migration adapter keeps a Postgres connection open for as
	// long as its supplied pool lives. Schema setup therefore owns a short-lived
	// pool that is closed before the policy assertion begins.
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

async function seedProtectedProject(auth: ReturnType<typeof createTestAuth>) {
	const now = new Date();
	const ctx = await auth.$context;
	await ctx.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: TEST_USER_ID,
			name: "Project deletion test user",
			email: "project-delete@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await ctx.adapter.create({
		model: "organization",
		forceAllowId: true,
		data: {
			id: TEST_PROJECT_ID,
			name: "Protected Project",
			slug: "protected-project",
			createdAt: now,
		},
	});
	await ctx.adapter.create({
		model: "member",
		forceAllowId: true,
		data: {
			id: "project-delete-owner-membership",
			organizationId: TEST_PROJECT_ID,
			userId: TEST_USER_ID,
			role: "owner",
			createdAt: now,
		},
	});
	await ctx.adapter.create({
		model: "session",
		data: {
			token: TEST_SESSION_TOKEN,
			userId: TEST_USER_ID,
			expiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
			activeOrganizationId: TEST_PROJECT_ID,
		},
	});
}

describe("Project deletion policy", () => {
	it("rejects HTTP and typed APIs before clearing the active Project or deleting rows", async () => {
		await migrateAuthSchema();
		const authPool = new Pool({ connectionString: dbHandle.uri, max: 1 });
		try {
			const auth = createTestAuth(authPool);
			await seedProtectedProject(auth);

			const headers = new Headers({
				cookie: `${SESSION_COOKIE}=${signSessionCookie(TEST_SESSION_TOKEN, TEST_SECRET)}`,
			});
			const httpHeaders = new Headers(headers);
			httpHeaders.set("content-type", "application/json");
			const response = await auth.handler(
				new Request("http://localhost:3000/api/auth/organization/delete", {
					method: "POST",
					headers: httpHeaders,
					body: JSON.stringify({ organizationId: TEST_PROJECT_ID }),
				}),
			);
			expect(response.status).toBe(404);
			await expect(response.json()).resolves.toMatchObject({
				code: "ORGANIZATION_DELETION_DISABLED",
			});

			await expect(
				auth.api.deleteOrganization({
					body: { organizationId: TEST_PROJECT_ID },
					headers,
				}),
			).rejects.toMatchObject({
				statusCode: 404,
				body: { code: "ORGANIZATION_DELETION_DISABLED" },
			});

			const ctx = await auth.$context;
			const storedSession = await ctx.adapter.findOne<{
				activeOrganizationId?: string | null;
			}>({
				model: "session",
				where: [{ field: "token", value: TEST_SESSION_TOKEN }],
			});
			const storedProject = await ctx.adapter.findOne<{ id: string }>({
				model: "organization",
				where: [{ field: "id", value: TEST_PROJECT_ID }],
			});
			const storedMembership = await ctx.adapter.findOne<{ id: string }>({
				model: "member",
				where: [
					{
						field: "id",
						value: "project-delete-owner-membership",
					},
				],
			});

			expect(storedSession?.activeOrganizationId).toBe(TEST_PROJECT_ID);
			expect(storedProject?.id).toBe(TEST_PROJECT_ID);
			expect(storedMembership?.id).toBe("project-delete-owner-membership");
		} finally {
			// Close the auth adapter's connection inside the test boundary so the
			// async-leak gate observes the same ownership discipline as production.
			await authPool.end();
		}
	});
});
