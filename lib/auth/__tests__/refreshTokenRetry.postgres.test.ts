import { createHash } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuth } from "@/lib/auth";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_refresh_retry_",
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
const redirectUri = "http://localhost:8123/callback";
const verifier = "v".repeat(64);
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", secret);
	vi.stubEnv("BETTER_AUTH_URL", origin);
});
afterEach(() => vi.unstubAllEnvs());

type Tokens = { access_token: string; refresh_token: string };

/** An MCP client signed in through the real authorize → consent → token
 * endpoints, holding its first refresh token. */
async function signedInMcpClient() {
	const auth = createAuth(database.pool);
	const client = await auth.api.registerOAuthClient({
		body: {
			client_name: "MCP client",
			redirect_uris: [redirectUri],
			application_type: "native",
			token_endpoint_auth_method: "none",
		},
	});
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: "mcp-user",
			name: "MCP user",
			email: "mcp@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await context.adapter.create({
		model: "session",
		data: {
			token: "mcp-session",
			userId: "mcp-user",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: now,
			updatedAt: now,
		},
	});
	const cookie = `better-auth.session_token=${signSessionCookie("mcp-session", secret)}`;

	const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
	authorization.search = new URLSearchParams({
		client_id: client.client_id,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid nova.read offline_access",
		state: "state",
		resource: MCP_RESOURCE_URL,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	const toConsent = await auth.handler(
		new Request(authorization, { headers: { cookie } }),
	);
	await toConsent.body?.cancel();
	const consentUrl = new URL(toConsent.headers.get("location") ?? "", origin);

	const consented = await auth.handler(
		new Request(`${origin}/api/auth/oauth2/consent`, {
			method: "POST",
			headers: { cookie, origin, "content-type": "application/json" },
			body: JSON.stringify({
				accept: true,
				oauth_query: consentUrl.search.slice(1),
			}),
		}),
	);
	const { url: callback } = (await consented.json()) as { url: string };
	const code = new URL(callback).searchParams.get("code");
	if (!code) throw new Error(`Consent returned no code: ${callback}`);

	const token = (body: Record<string, string>) =>
		auth.handler(
			new Request(`${origin}/api/auth/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: client.client_id, ...body }),
			}),
		);
	const first = await token({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
		resource: MCP_RESOURCE_URL,
	});
	const tokens = (await first.json()) as Tokens;
	if (!tokens.refresh_token)
		throw new Error(`No refresh token: ${JSON.stringify(tokens)}`);
	const refresh = (refreshToken: string) =>
		token({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: MCP_RESOURCE_URL,
		});
	return { tokens, refresh };
}

it("a refresh the client sends twice returns the same tokens and keeps it signed in", async () => {
	const { tokens, refresh } = await signedInMcpClient();

	// Two sessions sharing one credential file, or one client retrying after a
	// dropped response, both present the refresh token that was just rotated.
	const rotated = await refresh(tokens.refresh_token);
	expect(rotated.status).toBe(200);
	const next = (await rotated.json()) as Tokens;
	const retried = await refresh(tokens.refresh_token);
	expect(retried.status).toBe(200);
	const replay = (await retried.json()) as Tokens;
	expect(replay.refresh_token).toBe(next.refresh_token);
	expect(replay.access_token).toBe(next.access_token);

	const afterwards = await refresh(next.refresh_token);
	expect(afterwards.status).toBe(200);
	await afterwards.body?.cancel();
});
