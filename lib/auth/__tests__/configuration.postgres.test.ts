import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuth } from "@/lib/auth";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_configuration_",
	schema: "migrated",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
const origin = "http://localhost:3000";
const secret = "native-auth-configuration-secret-at-least-32-characters";
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", secret);
	vi.stubEnv("BETTER_AUTH_URL", origin);
});
afterEach(() => vi.unstubAllEnvs());

it("actual OAuth registration records allowed capabilities without granting user authorization", async () => {
	const auth = createAuth(database.pool);
	const common = {
		redirect_uris: ["https://client.example.test/callback"],
		token_endpoint_auth_method: "none" as const,
	};
	const baseline = await auth.api.registerOAuthClient({
		body: { ...common, client_name: "Baseline native client" },
	});
	const capabilities = [
		"email",
		"nova.hq.read",
		"nova.hq.write",
		"nova.projects.read",
		"nova.projects.write",
		"nova.read",
		"nova.write",
		"offline_access",
		"openid",
		"profile",
	];
	expect(baseline.scope?.split(" ").sort()).toEqual(capabilities);
	const delegated = await auth.api.registerOAuthClient({
		body: {
			...common,
			client_name: "Delegated native client",
			scope:
				"openid nova.read nova.hq.read nova.hq.write nova.projects.read nova.projects.write",
		},
	});
	expect(delegated.scope?.split(" ").sort()).toEqual(capabilities);
	await expect(
		auth.api.registerOAuthClient({
			body: {
				...common,
				client_name: "Forbidden native client",
				scope: "openid nova.admin",
			},
		}),
	).rejects.toMatchObject({ statusCode: 400 });
	const rows = await database.pool.query(
		"SELECT name, scopes FROM auth_oauth_client ORDER BY name",
	);
	expect(rows.rows.map((row) => row.name)).toEqual([
		"Baseline native client",
		"Delegated native client",
	]);
	expect(rows.rows.map((row) => [...row.scopes].sort())).toEqual([
		capabilities,
		capabilities,
	]);
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: "oauth-user",
			name: "OAuth user",
			email: "oauth@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await context.adapter.create({
		model: "session",
		data: {
			token: "oauth-token",
			userId: "oauth-user",
			expiresAt: new Date(Date.now() + 60000),
			createdAt: now,
			updatedAt: now,
		},
	});
	const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
	authorization.search = new URLSearchParams({
		client_id: baseline.client_id,
		redirect_uri: common.redirect_uris[0],
		response_type: "code",
		scope: "openid nova.read",
		state: "native-state",
		code_challenge: "a".repeat(43),
		code_challenge_method: "S256",
	}).toString();
	const response = await auth.handler(
		new Request(authorization, {
			headers: {
				cookie: `better-auth.session_token=${signSessionCookie("oauth-token", secret)}`,
			},
		}),
	);
	await response.body?.cancel();
	expect(response.status).toBe(302);
	const location = response.headers.get("location");
	if (location === null)
		throw new Error("Authorization did not redirect to consent");
	const consent = new URL(location, origin);
	expect(consent.pathname).toBe("/consent");
	expect(consent.searchParams.get("scope")).toBe("openid nova.read");
	expect(consent.searchParams.get("state")).toBe("native-state");

	for (const table of [
		"auth_oauth_consent",
		"auth_oauth_access_token",
		"auth_oauth_refresh_token",
	]) {
		expect((await database.pool.query(`SELECT * FROM ${table}`)).rows).toEqual(
			[],
		);
	}
});

it("actual organization deletion refuses before changing sessions, membership or project", async () => {
	const auth = createAuth(database.pool);
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: "configuration-user",
			name: "Owner",
			email: "configuration@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await context.adapter.create({
		model: "organization",
		forceAllowId: true,
		data: {
			id: "configuration-project",
			name: "Protected",
			slug: "configuration-project",
			createdAt: now,
		},
	});
	await context.adapter.create({
		model: "member",
		forceAllowId: true,
		data: {
			id: "configuration-membership",
			userId: "configuration-user",
			organizationId: "configuration-project",
			role: "owner",
			createdAt: now,
		},
	});
	await context.adapter.create({
		model: "session",
		data: {
			token: "configuration-token",
			userId: "configuration-user",
			activeOrganizationId: "configuration-project",
			expiresAt: new Date(Date.now() + 60000),
			createdAt: now,
			updatedAt: now,
		},
	});
	const headers = new Headers({
		cookie: `better-auth.session_token=${signSessionCookie("configuration-token", secret)}`,
		origin,
		"content-type": "application/json",
	});
	const request = new Request(`${origin}/api/auth/organization/delete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ organizationId: "configuration-project" }),
	});
	try {
		const response = await auth.handler(request);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			code: "ORGANIZATION_DELETION_DISABLED",
		});
	} finally {
		if (!request.bodyUsed) await request.body?.cancel();
	}
	const project = await database.pool.query(
		"SELECT id FROM auth_organization WHERE id = 'configuration-project'",
	);
	const member = await database.pool.query(
		"SELECT id FROM auth_member WHERE id = 'configuration-membership'",
	);
	const session = await database.pool.query(
		`SELECT "activeOrganizationId" FROM auth_session WHERE token = 'configuration-token'`,
	);
	expect(project.rows).toEqual([{ id: "configuration-project" }]);
	expect(member.rows).toEqual([{ id: "configuration-membership" }]);
	expect(session.rows).toEqual([
		{ activeOrganizationId: "configuration-project" },
	]);
});
