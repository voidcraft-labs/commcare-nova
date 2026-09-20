import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as authModule from "@/lib/auth";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { GET } from "../route";

// The route handler, Better Auth's authorize endpoint, and the client lookup
// all run their production code against a real database. Only `getAuth()` is
// pointed at the per-test pool instead of the process-wide singleton.
const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_authorize_issue_",
	schema: "migrated",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
const origin = "http://localhost:3000";
const redirectUri = "http://localhost:3118/callback";
let auth: authModule.Auth;
beforeEach(() => {
	vi.stubEnv(
		"BETTER_AUTH_SECRET",
		"authorize-issue-secret-at-least-32-characters",
	);
	vi.stubEnv("BETTER_AUTH_URL", origin);
	auth = authModule.createAuth(database.pool);
	vi.spyOn(authModule, "getAuth").mockResolvedValue(auth);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function authorizeRequest(clientId: string, accept: string): Request {
	const url = new URL(`${origin}/api/auth/oauth2/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code_challenge: "a".repeat(43),
		code_challenge_method: "S256",
		state: "x",
	}).toString();
	return new Request(url, { headers: { accept } });
}

it("sends a browser whose client id Nova doesn't know to the connection-issue page", async () => {
	const response = await GET(authorizeRequest("does-not-exist", "text/html"));
	await response.body?.cancel();

	expect(response.status).toBe(302);
	const location = response.headers.get("location");
	if (location === null) throw new Error("Expected a Location header");
	const destination = new URL(location, origin);
	expect(destination.origin).toBe(origin);
	expect(destination.pathname).toBe("/connection-issue");
	expect(destination.searchParams.get("reason")).toBe("unknown-client");
	expect(location).not.toContain("error_description");
	expect(location).not.toContain("client_id");
	expect(location).not.toContain("does-not-exist");
});

it("returns the same refusal untouched to a caller that asked for JSON", async () => {
	const response = await GET(
		authorizeRequest("does-not-exist", "application/json"),
	);
	const body = (await response.json()) as { redirect?: boolean; url?: string };

	/* Better Auth's fetch form of the redirect: the caller reads the error
	 * itself, so the provider's own destination must survive. */
	expect(response.status).toBe(200);
	expect(response.headers.get("location")).toBeNull();
	expect(body.redirect).toBe(true);
	const target = new URL(body.url ?? "", origin);
	expect(target.pathname).toBe("/");
	expect(target.searchParams.get("error")).toBe("invalid_client");
});

it("leaves the sign-in redirect for a known client alone", async () => {
	const client = await auth.api.registerOAuthClient({
		body: {
			client_name: "Known native client",
			application_type: "native",
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
		},
	});
	const response = await GET(authorizeRequest(client.client_id, "text/html"));
	await response.body?.cancel();

	/* Signed out, so Better Auth sends the browser to Nova's sign-in surface at
	 * `/`: the same pathname the error redirect uses, told apart only by the
	 * absent `error` parameter. */
	expect(response.status).toBe(302);
	const location = response.headers.get("location");
	if (location === null) throw new Error("Expected a Location header");
	const destination = new URL(location, origin);
	expect(destination.pathname).toBe("/");
	expect(destination.searchParams.has("error")).toBe(false);
	expect(destination.searchParams.get("client_id")).toBe(client.client_id);
});
