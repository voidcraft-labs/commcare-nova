import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as authRouteGET } from "@/app/api/auth/[...all]/route";
import * as authModule from "@/lib/auth";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	getOAuthClientDiscovery,
	listAuthorizedClients,
} from "@/lib/db/oauth-consents";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";

// Better Auth, the oauth-provider, and the cimd plugin all run their production
// code against a real database. The one controlled boundary is the transport the
// plugin reads client documents through: the public internet is replaced by a
// test-owned function that answers for known URLs.
const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_cimd_",
	schema: "migrated",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
const origin = "http://localhost:3000";
const secret = "cimd-configuration-secret-at-least-32-characters";
const redirectUri = "http://localhost:3118/callback";

/** Claude Code's published document, byte for byte in its fields. */
const CLAUDE_CODE_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_CODE_DOCUMENT = {
	client_id: CLAUDE_CODE_ID,
	client_name: "Claude Code",
	client_uri: "https://claude.ai",
	redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
};

/** A document served from one URL that claims to be another client. */
const IMPOSTOR_ID = "https://impostor.example/oauth/client.json";
const IMPOSTOR_DOCUMENT = { ...CLAUDE_CODE_DOCUMENT };

const documents = new Map<string, unknown>([
	[CLAUDE_CODE_ID, CLAUDE_CODE_DOCUMENT],
	[IMPOSTOR_ID, IMPOSTOR_DOCUMENT],
]);
let fetched: string[];
async function controlledFetch(input: RequestInfo | URL): Promise<Response> {
	const url = input instanceof Request ? input.url : String(input);
	fetched.push(url);
	const document = documents.get(url);
	if (document === undefined) return new Response(null, { status: 404 });
	return Response.json(document);
}

let auth: authModule.Auth;
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", secret);
	vi.stubEnv("BETTER_AUTH_URL", origin);
	fetched = [];
	auth = authModule.createAuth(database.pool, {
		fetchClientMetadataResource: controlledFetch,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** Seed a signed-in person and return their session cookie header. */
async function signIn(): Promise<string> {
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: "cimd-user",
			name: "CIMD user",
			email: "cimd@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await context.adapter.create({
		model: "session",
		data: {
			token: "cimd-token",
			userId: "cimd-user",
			expiresAt: new Date(Date.now() + 60000),
			createdAt: now,
			updatedAt: now,
		},
	});
	return `better-auth.session_token=${signSessionCookie("cimd-token", secret)}`;
}

function authorizeRequest(clientId: string, cookie: string): Request {
	const url = new URL(`${origin}/api/auth/oauth2/authorize`);
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid nova.read",
		state: "cimd-state",
		code_challenge: "a".repeat(43),
		code_challenge_method: "S256",
		resource: MCP_RESOURCE_URL,
	}).toString();
	return new Request(url, { headers: { cookie, accept: "text/html" } });
}

/** Authorize and return where the browser is sent. */
async function authorize(clientId: string, cookie: string): Promise<URL> {
	const response = await auth.handler(authorizeRequest(clientId, cookie));
	await response.body?.cancel();
	expect(response.status).toBe(302);
	const location = response.headers.get("location");
	if (location === null) throw new Error("Authorization did not redirect");
	return new URL(location, origin);
}

async function clientRows(clientId: string) {
	const result = await database.pool.query<{
		name: string | null;
		clientDiscoveryId: string | null;
	}>(
		`SELECT name, "clientDiscoveryId" FROM auth_oauth_client WHERE "clientId" = $1`,
		[clientId],
	);
	return result.rows;
}

async function resourceLinks(clientId: string) {
	const result = await database.pool.query<{ resourceId: string }>(
		`SELECT "resourceId" FROM auth_oauth_client_resource WHERE "clientId" = $1`,
		[clientId],
	);
	return result.rows;
}

it("advertises Client ID Metadata Document support in the server metadata", async () => {
	const response = await oauthProviderAuthServerMetadata(auth)(
		new Request(`${origin}/.well-known/oauth-authorization-server`),
	);
	const metadata = (await response.json()) as Record<string, unknown>;
	expect(response.status).toBe(200);
	expect(metadata.client_id_metadata_document_supported).toBe(true);
	/* Dynamic registration stays advertised for clients that don't speak CIMD. */
	expect(metadata.registration_endpoint).toBe(
		`${origin}/api/auth/oauth2/register`,
	);
});

it("takes a URL client id to consent and keeps a client linked to the MCP resource", async () => {
	const cookie = await signIn();
	const consent = await authorize(CLAUDE_CODE_ID, cookie);

	expect(consent.pathname).toBe("/consent");
	expect(consent.searchParams.get("client_id")).toBe(CLAUDE_CODE_ID);
	expect(fetched).toContain(CLAUDE_CODE_ID);
	expect(await clientRows(CLAUDE_CODE_ID)).toEqual([
		{ name: "Claude Code", clientDiscoveryId: "cimd" },
	]);
	expect(await resourceLinks(CLAUDE_CODE_ID)).toEqual([
		{ resourceId: MCP_RESOURCE_URL },
	]);
});

it("rebuilds a missing client from its URL", async () => {
	const cookie = await signIn();
	await authorize(CLAUDE_CODE_ID, cookie);
	await database.pool.query(
		`DELETE FROM auth_oauth_client_resource WHERE "clientId" = $1`,
		[CLAUDE_CODE_ID],
	);
	await database.pool.query(
		`DELETE FROM auth_oauth_client WHERE "clientId" = $1`,
		[CLAUDE_CODE_ID],
	);
	expect(await clientRows(CLAUDE_CODE_ID)).toEqual([]);

	const consent = await authorize(CLAUDE_CODE_ID, cookie);

	expect(consent.pathname).toBe("/consent");
	expect(await clientRows(CLAUDE_CODE_ID)).toEqual([
		{ name: "Claude Code", clientDiscoveryId: "cimd" },
	]);
	expect(await resourceLinks(CLAUDE_CODE_ID)).toEqual([
		{ resourceId: MCP_RESOURCE_URL },
	]);
});

it("still takes a dynamically registered client to consent", async () => {
	const cookie = await signIn();
	const registered = await auth.api.registerOAuthClient({
		body: {
			client_name: "Registered native client",
			application_type: "native",
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
		},
	});

	const consent = await authorize(registered.client_id, cookie);

	expect(consent.pathname).toBe("/consent");
	expect(fetched).toEqual([]);
	expect(await clientRows(registered.client_id)).toEqual([
		{ name: "Registered native client", clientDiscoveryId: null },
	]);
});

it("reads the identifying host for a document client and none for a registered one", async () => {
	const cookie = await signIn();
	await authorize(CLAUDE_CODE_ID, cookie);
	const registered = await auth.api.registerOAuthClient({
		body: {
			client_name: "Registered native client",
			application_type: "native",
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
		},
	});
	const context = await auth.$context;
	for (const [clientId, createdAt] of [
		[CLAUDE_CODE_ID, new Date("2026-04-20T12:00:00.000Z")],
		[registered.client_id, new Date("2026-04-19T12:00:00.000Z")],
	] as const) {
		await context.adapter.create({
			model: "oauthConsent",
			data: {
				clientId,
				userId: "cimd-user",
				scopes: ["nova.read"],
				createdAt,
				updatedAt: createdAt,
			},
		});
	}

	/* The app-owned reads run against the rows the plugins themselves wrote. */
	const authDb = new Kysely<AuthDatabase>({
		dialect: new PostgresDialect({
			pool: database.pool as unknown as PostgresPool,
		}),
	});
	__setAuthDbForTests(authDb);
	try {
		expect(await getOAuthClientDiscovery(CLAUDE_CODE_ID)).toBe("cimd");
		expect(await getOAuthClientDiscovery(registered.client_id)).toBeNull();
		expect(await getOAuthClientDiscovery("no-such-client")).toBeNull();
		expect(
			(await listAuthorizedClients("cimd-user")).map((row) => [
				row.clientName,
				row.identityHost,
			]),
		).toEqual([
			["Claude Code", "claude.ai"],
			["Registered native client", null],
		]);
	} finally {
		__setAuthDbForTests(null);
	}
});

it("sends a browser to the connection-issue page when a document names a different client", async () => {
	const cookie = await signIn();
	vi.spyOn(authModule, "getAuth").mockResolvedValue(auth);

	/* One request only: the plugin paces a retry of a failed document, so a
	 * second authorize inside that interval is a 429, a different refusal.
	 * Better Auth answers this one with a bare JSON `invalid_client`; Nova's
	 * route is what turns that into a page the person can act on. */
	const response = await authRouteGET(authorizeRequest(IMPOSTOR_ID, cookie));
	await response.body?.cancel();

	expect(fetched).toEqual([IMPOSTOR_ID]);
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toBe(
		"/connection-issue?reason=client-unavailable",
	);
	expect(await clientRows(IMPOSTOR_ID)).toEqual([]);
});
