/**
 * The `nova.hq.import` repair (`scripts/lib/hqImportScope.ts`), over grants the
 * authorization server and the API key plugin made themselves, under a client
 * capability list without the scope, as the grants made before it existed were.
 *
 * Contract: one run gives the scope to every client list that lacks it and to
 * every consent, live refresh token and enabled API key holding both HQ scopes,
 * and to nothing else; the dry run the scan prints counts exactly those rows
 * and writes nothing; and a second run changes nothing. Then, through the
 * provider: a repaired refresh token refreshes into an access token holding the
 * scope with no step of the person's, an authorize for the whole list goes back
 * to the client without consent, a grant with no HQ scope still goes to
 * consent, a repaired key passes an import tool's scope check while a narrower
 * key is refused, and a client registered afterwards holds the scope by
 * registration while its person is still asked.
 *
 * Plausible failures: a dry run that writes; the scan counting rows the writer
 * leaves, or the reverse; a rotated, expired or revoked token, a disabled key
 * or a grant without both HQ scopes given the scope; a null client list frozen
 * into a list of its own; a repaired token whose refresh the provider refuses
 * because the client's list lacks the scope; a second run appending it again.
 */

import { createHash } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuth } from "@/lib/auth";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { signSessionCookie } from "@/lib/auth/sessionCookie";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";
import { assertScope, McpScopeError, TOOL_SCOPES } from "@/lib/mcp/scopes";
import { IMPORT_SCOPE, repairImportScope } from "../lib/hqImportScope";

const database = setupPerTestDatabase({
	databaseNamePrefix: "hq_import_scope_",
	schema: "migrated",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
const origin = "http://localhost:3000";
const secret = "hq-import-scope-repair-secret-at-least-32-characters";
const redirectUri = "http://localhost:8123/callback";
const verifier = "v".repeat(64);
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", secret);
	vi.stubEnv("BETTER_AUTH_URL", origin);
});
afterEach(() => vi.unstubAllEnvs());

/** Every scope a grant could hold before bringing apps in had a scope of its own. */
const PRE_IMPORT_SCOPES = [
	"openid",
	"offline_access",
	"profile",
	"email",
	"nova.read",
	"nova.write",
	"nova.hq.read",
	"nova.hq.write",
	"nova.projects.read",
	"nova.projects.write",
];
const NO_HQ_SCOPES = ["openid", "offline_access", "nova.read", "nova.write"];

type Auth = ReturnType<typeof createAuth>;
type Tokens = { access_token: string; refresh_token: string; scope: string };

/** A client the server registers, its stored list then set as `scopes` says. */
async function client(
	auth: Auth,
	name: string,
	scopes: readonly string[] | null | "as-registered",
	discovery: "cimd" | null = null,
): Promise<string> {
	const registered = await auth.api.registerOAuthClient({
		body: {
			client_name: name,
			redirect_uris: [redirectUri],
			application_type: "native",
			token_endpoint_auth_method: "none",
		},
	});
	await database.pool.query(
		`UPDATE auth_oauth_client SET "clientDiscoveryId" = $1 WHERE "clientId" = $2`,
		[discovery, registered.client_id],
	);
	if (scopes !== "as-registered")
		await database.pool.query(
			'UPDATE auth_oauth_client SET scopes = $1::jsonb WHERE "clientId" = $2',
			[scopes === null ? null : JSON.stringify(scopes), registered.client_id],
		);
	return registered.client_id;
}

/** A person with a browser session, by id. */
async function person(auth: Auth, id: string): Promise<string> {
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id,
			name: id,
			email: `${id}@dimagi.com`,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await context.adapter.create({
		model: "session",
		data: {
			token: `${id}-session`,
			userId: id,
			expiresAt: new Date(Date.now() + 600_000),
			createdAt: now,
			updatedAt: now,
		},
	});
	return `better-auth.session_token=${signSessionCookie(`${id}-session`, secret)}`;
}

/** Where an authorize by the person with `cookie` for `scopes` goes. */
async function authorize(
	auth: Auth,
	clientId: string,
	cookie: string,
	scopes: readonly string[],
): Promise<URL> {
	const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
	authorization.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: scopes.join(" "),
		resource: MCP_RESOURCE_URL,
		state: "state",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	const response = await auth.handler(
		new Request(authorization, { headers: { cookie } }),
	);
	await response.body?.cancel();
	expect(response.status).toBe(302);
	return new URL(response.headers.get("location") ?? "", origin);
}

/** A call to the token endpoint for the public client `clientId`. */
function token(
	auth: Auth,
	clientId: string,
	body: Record<string, string>,
): Promise<Response> {
	return auth.handler(
		new Request(`${origin}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId, ...body }),
		}),
	);
}

/** The person approves `scopes` at consent and the client takes its first tokens. */
async function signIn(
	auth: Auth,
	clientId: string,
	cookie: string,
	scopes: readonly string[],
): Promise<Tokens> {
	const toConsent = await authorize(auth, clientId, cookie, scopes);
	expect(toConsent.pathname).toBe("/consent");
	const consented = await auth.handler(
		new Request(`${origin}/api/auth/oauth2/consent`, {
			method: "POST",
			headers: { cookie, origin, "content-type": "application/json" },
			body: JSON.stringify({
				accept: true,
				oauth_query: toConsent.search.slice(1),
			}),
		}),
	);
	const { url } = (await consented.json()) as { url: string };
	const code = new URL(url).searchParams.get("code");
	if (!code) throw new Error(`Consent returned no code: ${url}`);
	const exchanged = await token(auth, clientId, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
		resource: MCP_RESOURCE_URL,
	});
	expect(exchanged.status).toBe(200);
	return (await exchanged.json()) as Tokens;
}

/** A refresh as an MCP client sends it: no `scope`, the resource it holds. */
async function refresh(
	auth: Auth,
	clientId: string,
	refreshToken: string,
): Promise<Tokens> {
	const refreshed = await token(auth, clientId, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		resource: MCP_RESOURCE_URL,
	});
	expect(refreshed.status).toBe(200);
	return (await refreshed.json()) as Tokens;
}

/** The `scope` claim of a JWT access token. */
function claimedScopes(accessToken: string): string[] {
	const [, payload] = accessToken.split(".");
	const claims = JSON.parse(
		Buffer.from(payload ?? "", "base64url").toString(),
	) as { scope?: string };
	return (claims.scope ?? "").split(" ").filter(Boolean);
}

/** Every grant row, by table and id, as the repair could change it. */
async function grants(): Promise<Record<string, unknown>> {
	const read = async (table: string, columns: string) =>
		(
			await database.pool.query<{ id: string }>(
				`SELECT id, ${columns} FROM ${table} ORDER BY id`,
			)
		).rows.map((row) => [`${table}:${row.id}`, row] as const);
	return Object.fromEntries([
		...(await read("auth_oauth_client", 'scopes, "updatedAt"')),
		...(await read("auth_oauth_consent", 'scopes, "updatedAt"')),
		...(await read("auth_oauth_refresh_token", "scopes")),
		...(await read("auth_apikey", 'permissions, "updatedAt"')),
	]);
}

/** An API key the plugin makes for `userId` holding `scope`. */
async function apiKey(
	auth: Auth,
	userId: string,
	name: string,
	scope: readonly string[],
): Promise<{ id: string; key: string }> {
	const created = await auth.api.createApiKey({
		body: { name, permissions: { scope: [...scope] }, userId },
	});
	return { id: created.id, key: created.key };
}

/** The scopes an MCP call made with `key` carries, as the route reads them. */
async function keyScopes(auth: Auth, key: string): Promise<string[]> {
	const verified = await auth.api.verifyApiKey({ body: { key } });
	expect(verified.valid).toBe(true);
	const scope = verified.key?.permissions?.scope;
	return Array.isArray(scope) ? scope : [];
}

it("gives the scope to what held both HQ scopes before it existed, once, and to nothing else", async () => {
	const auth = createAuth(database.pool);

	/* Clients as production's are: a registered one with the list of its day, one holding the
	 * scope, one with no list of its own, and one a metadata document wrote. */
	const standing = await client(auth, "Standing client", PRE_IMPORT_SCOPES);
	await client(auth, "Holding client", "as-registered");
	await client(auth, "Listless client", null);
	await client(auth, "Document client", PRE_IMPORT_SCOPES, "cimd");

	/* A person who approved reading and writing CommCare HQ, whose client refreshed once, so one
	 * token is rotated and one is live. */
	const reader = await person(auth, "hq-person");
	const first = await signIn(auth, standing, reader, PRE_IMPORT_SCOPES);
	const live = await refresh(auth, standing, first.refresh_token);
	expect(claimedScopes(live.access_token)).not.toContain(IMPORT_SCOPE);
	/* Before the repair the client's list refuses the scope. */
	const refused = await authorize(auth, standing, reader, [
		...PRE_IMPORT_SCOPES,
		IMPORT_SCOPE,
	]);
	expect(refused.searchParams.get("error")).toBe("invalid_scope");

	/* A person who approved no HQ scope. */
	const plain = await person(auth, "plain-person");
	const plainTokens = await signIn(auth, standing, plain, NO_HQ_SCOPES);

	/* A person who approved both, whose only token has expired. */
	const lapsed = await person(auth, "lapsed-person");
	await signIn(auth, standing, lapsed, PRE_IMPORT_SCOPES);
	await database.pool.query(
		`UPDATE auth_oauth_refresh_token SET "expiresAt" = now() - interval '1 day' WHERE "userId" = 'lapsed-person'`,
	);

	/* Keys: both HQ scopes, one, none, and both but disabled. */
	const floor = ["nova.read", "nova.write"];
	const full = await apiKey(auth, "hq-person", "Full key", [
		...floor,
		"nova.hq.read",
		"nova.hq.write",
	]);
	const narrow = await apiKey(auth, "hq-person", "Narrow key", [
		...floor,
		"nova.hq.read",
	]);
	await apiKey(auth, "hq-person", "Plain key", floor);
	const disabled = await apiKey(auth, "hq-person", "Disabled key", [
		...floor,
		"nova.hq.read",
		"nova.hq.write",
	]);
	await database.pool.query(
		"UPDATE auth_apikey SET enabled = false WHERE id = $1",
		[disabled.id],
	);

	const before = await grants();

	/* The dry run, which is what the scan prints, counts and writes nothing. */
	const dry = await repairImportScope(database.db, { execute: false });
	const expected = [
		{ kind: "client", changes: 2, leaves: 2 },
		{ kind: "consent", changes: 2, leaves: 1 },
		{ kind: "refresh-token", changes: 1, leaves: 3 },
		{ kind: "api-key", changes: 1, leaves: 3 },
	];
	expect(dry).toEqual({ written: false, kinds: expected });
	expect(await grants()).toEqual(before);

	/* The writer changes exactly what the dry run counted. */
	const ran = await repairImportScope(database.db, { execute: true });
	expect(ran).toEqual({ written: true, kinds: expected });
	const after = await grants();
	const changed = Object.keys(after).filter(
		(row) => JSON.stringify(after[row]) !== JSON.stringify(before[row]),
	);
	expect(changed).toHaveLength(6);
	for (const row of changed)
		expect(JSON.stringify(after[row])).toContain(IMPORT_SCOPE);
	const { rows: listless } = await database.pool.query(
		`SELECT scopes FROM auth_oauth_client WHERE name = 'Listless client'`,
	);
	expect(listless).toEqual([{ scopes: null }]);
	const { rows: tokens } = await database.pool.query<{
		userId: string;
		live: boolean;
		holds: boolean;
	}>(
		`SELECT "userId", (revoked IS NULL AND "expiresAt" > now()) AS live, scopes ? $1 AS holds
		 FROM auth_oauth_refresh_token ORDER BY "userId", live`,
		[IMPORT_SCOPE],
	);
	expect(tokens).toEqual([
		{ userId: "hq-person", live: false, holds: false },
		{ userId: "hq-person", live: true, holds: true },
		{ userId: "lapsed-person", live: false, holds: false },
		{ userId: "plain-person", live: true, holds: false },
	]);

	/* A second run changes nothing. */
	const again = await repairImportScope(database.db, { execute: true });
	expect(again.kinds.map((count) => count.changes)).toEqual([0, 0, 0, 0]);
	expect(await grants()).toEqual(after);

	/* (i) The client's next refresh, sent as an MCP client sends it, holds the scope: no browser,
	 * no consent. */
	const upgraded = await refresh(auth, standing, live.refresh_token);
	expect(upgraded.scope.split(" ")).toContain(IMPORT_SCOPE);
	expect(claimedScopes(upgraded.access_token)).toContain(IMPORT_SCOPE);

	/* (ii) Asking for the whole list goes straight back to the client with a code. */
	const reauthorized = await authorize(auth, standing, reader, [
		...PRE_IMPORT_SCOPES,
		IMPORT_SCOPE,
	]);
	expect(reauthorized.origin).toBe(new URL(redirectUri).origin);
	expect(reauthorized.searchParams.get("code")).not.toBeNull();

	/* (iii) The grant with no HQ scope gained nothing, refreshes without it, and goes to consent
	 * when it asks. */
	const plainRefreshed = await refresh(
		auth,
		standing,
		plainTokens.refresh_token,
	);
	expect(plainRefreshed.scope.split(" ")).not.toContain(IMPORT_SCOPE);
	const plainAsks = await authorize(auth, standing, plain, [
		...NO_HQ_SCOPES,
		IMPORT_SCOPE,
	]);
	expect(plainAsks.pathname).toBe("/consent");

	/* (iv) The repaired key passes an import tool's scope check; the narrower one is refused the
	 * scope. */
	const [importScope, ...rest] = TOOL_SCOPES.bring_in_hq_app;
	expect(rest).toEqual([]);
	expect(importScope).toBe(IMPORT_SCOPE);
	const fullContext = {
		scopes: await keyScopes(auth, full.key),
		authKind: "api-key" as const,
	};
	expect(() =>
		assertScope(fullContext, importScope, "bring_in_hq_app"),
	).not.toThrow();
	const narrowContext = {
		scopes: await keyScopes(auth, narrow.key),
		authKind: "api-key" as const,
	};
	expect(() =>
		assertScope(narrowContext, importScope, "bring_in_hq_app"),
	).toThrow(McpScopeError);

	/* (vi) A client registered afterwards holds the scope by registration, and its person is
	 * still asked, whatever they approved for another client. */
	const fresh = await client(auth, "Fresh client", "as-registered");
	const { rows: freshList } = await database.pool.query<{ holds: boolean }>(
		`SELECT scopes ? $1 AS holds FROM auth_oauth_client WHERE "clientId" = $2`,
		[IMPORT_SCOPE, fresh],
	);
	expect(freshList).toEqual([{ holds: true }]);
	const freshAsks = await authorize(auth, fresh, reader, [
		...PRE_IMPORT_SCOPES,
		IMPORT_SCOPE,
	]);
	expect(freshAsks.pathname).toBe("/consent");
});
