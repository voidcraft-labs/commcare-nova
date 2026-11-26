import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import type { Auth } from "@/lib/auth";
import type { AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { AppDatabase } from "@/lib/db/pg";
import type { ToolContext } from "@/lib/mcp/types";

const seenCaller = vi.hoisted(() => ({ verified: null as ToolContext | null }));
// Only the tool payload is diagnostic: authentication, protocol dispatch, JWT
// verification, JWKS transport and persistence all run their production code.
vi.mock("@/lib/mcp/server", () => ({
	registerNovaTools: (
		server: import("@modelcontextprotocol/server").McpServer,
		context: import("@/lib/mcp/types").ToolContext,
	) => {
		seenCaller.verified = context;
		server.registerTool(
			"caller",
			{ description: "Return verified caller", inputSchema: {} },
			async () => ({
				content: [{ type: "text" as const, text: JSON.stringify(context) }],
			}),
		);
	},
}));
const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "native_mcp_auth_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
let server: Server;
let origin: string;
let auth: Auth;
let authModule: typeof import("@/lib/auth");
let authDbModule: typeof import("@/lib/auth/db");
let route: typeof import("@/app/api/mcp/route");
let jwksReads = 0;
const pending = new Set<Promise<void>>();
const errors: unknown[] = [];
beforeAll(async () => {
	server = createServer((req, res) => {
		const work = (async () => {
			if (req.url !== "/api/auth/jwks") {
				res.writeHead(404);
				res.end();
				return;
			}
			jwksReads++;
			const response = await auth.handler(new Request(`${origin}${req.url}`));
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(await response.text());
		})().catch((error) => {
			errors.push(error);
			res.writeHead(500);
			res.end();
		});
		pending.add(work);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing loopback port");
	origin = `http://127.0.0.1:${address.port}`;
	vi.resetModules();
	vi.doMock("@/lib/hostnames", async () => ({
		...(await vi.importActual<typeof import("@/lib/hostnames")>(
			"@/lib/hostnames",
		)),
		AS_ORIGIN: origin,
		AS_ISSUER: `${origin}/api/auth`,
		MCP_RESOURCE_ORIGIN: origin,
		MCP_RESOURCE_PATH: "/api/mcp",
		MCP_RESOURCE_URL: `${origin}/api/mcp`,
		MCP_RESOURCE_METADATA_URL: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
	}));
	authModule = await import("@/lib/auth");
	authDbModule = await import("@/lib/auth/db");
	route = await import("@/app/api/mcp/route");
});
beforeEach(async () => {
	vi.stubEnv(
		"BETTER_AUTH_SECRET",
		"native-mcp-auth-secret-at-least-32-characters",
	);
	vi.stubEnv("BETTER_AUTH_URL", origin);
	vi.stubEnv("NODE_ENV", "production");
	auth = authModule.createAuth(dbHandle.pool);
	// Better Auth captures NODE_ENV before Vitest fixtures run. Enable its native
	// limiter exactly as production does; the rule and storage remain unchanged.
	(await auth.$context).rateLimit.enabled = true;
	vi.spyOn(authModule, "getAuth").mockResolvedValue(auth);
	authDbModule.__setAuthDbForTests(
		new Kysely<AuthDatabase>({
			dialect: new PostgresDialect({
				pool: dbHandle.pool as unknown as PostgresPool,
			}),
		}),
	);
});
afterEach(() => {
	authDbModule.__setAuthDbForTests(null);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	await Promise.all(pending);
	expect(errors).toEqual([]);
	vi.doUnmock("@/lib/hostnames");
});
async function call(bearer: string, ip = "192.0.2.45") {
	const request = new Request(`${origin}/api/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${bearer}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"x-nova-client-ip": ip,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "caller", arguments: {} },
		}),
	});
	try {
		const response = await route.POST(request);
		const text = await response.text();
		return { status: response.status, headers: response.headers, text };
	} finally {
		if (!request.bodyUsed) await request.body?.cancel();
	}
}
async function seed() {
	const context = await auth.$context;
	const now = new Date();
	await context.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: "native-user",
			name: "Native user",
			email: "native@dimagi.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	const client = await auth.api.registerOAuthClient({
		body: {
			client_name: "Native MCP",
			application_type: "native",
			redirect_uris: ["http://127.0.0.1:9999/callback"],
			token_endpoint_auth_method: "none",
		},
	});
	const consent = await context.adapter.create<{ id: string }>({
		model: "oauthConsent",
		data: {
			clientId: client.client_id,
			userId: "native-user",
			scopes: ["nova.read", "nova.write"],
			createdAt: now,
			updatedAt: now,
		},
	});
	return { clientId: client.client_id, consentId: consent.id };
}
it("rechecks the signed OAuth installation grant against its expiry, consent and revocation watermark at the consuming transaction", async () => {
	const { clientId, consentId } = await seed();
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		sub: "native-user",
		azp: clientId,
		iat: now,
		exp: now + 240,
		iss: `${origin}/api/auth`,
		aud: `${origin}/api/mcp`,
		scope: "nova.read nova.write nova.hq.import nova.hq.write",
	};
	const token = (await auth.api.signJWT({ body: { payload: claims } })).token;
	expect((await call(token)).status).toBe(200);
	const caller = seenCaller.verified;
	if (caller?.grant?.kind !== "oauth")
		throw new Error("Missing signed client identity");
	const { credentialWriteGrant } = await import(
		"@/lib/mcp/credentialWriteGrant"
	);
	const { recordOAuthGrantRevocation, revokeAuthorizedClient } = await import(
		"@/lib/db/oauth-consents"
	);
	// The shared test database owns the pool's teardown, as it does for Better Auth.
	const db = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({
			pool: dbHandle.pool as unknown as PostgresPool,
		}),
	});
	const granted = [
		"nova.read",
		"nova.write",
		"nova.hq.import",
		"nova.hq.write",
	];
	const setScopes = (scopes: readonly string[]) =>
		dbHandle.pool.query(
			"UPDATE auth_oauth_consent SET scopes=$1::jsonb WHERE id=$2",
			[JSON.stringify(scopes), consentId],
		);
	await setScopes(granted);
	const grant = credentialWriteGrant(caller, "bring_in_hq_app", [
		"nova.hq.import",
		"nova.hq.write",
	]);
	const consume = () => db.transaction().execute((tx) => grant(tx));
	await consume();
	await setScopes(granted.filter((s) => s !== "nova.hq.write"));
	await expect(consume()).rejects.toMatchObject({
		name: "McpCredentialInactiveError",
	});
	await setScopes(granted);
	await consume();
	// A verified caller keeps the original expiry while Nova reads the app.
	const nearExpiry = Math.floor(Date.now() / 1000) + 2;
	const short = (
		await auth.api.signJWT({
			body: { payload: { ...claims, exp: nearExpiry } },
		})
	).token;
	expect((await call(short)).status).toBe(200);
	const shortCaller = seenCaller.verified;
	if (!shortCaller) throw new Error("Missing expiring signed client identity");
	const shortGrant = credentialWriteGrant(shortCaller, "bring_in_hq_app", [
		"nova.hq.import",
		"nova.hq.write",
	]);
	await db.transaction().execute((tx) => shortGrant(tx));
	await dbHandle.pool.query("SELECT pg_sleep_until(to_timestamp($1))", [
		nearExpiry,
	]);
	await expect(
		db.transaction().execute((tx) => shortGrant(tx)),
	).rejects.toMatchObject({ name: "McpCredentialInactiveError" });
	await recordOAuthGrantRevocation(caller.userId, clientId);
	await expect(consume()).rejects.toMatchObject({
		name: "McpCredentialInactiveError",
	});
	// A newly authorized token gets its own signed issue time. The persisted
	// watermark remains and applies independently of the continued consent row.
	await dbHandle.pool.query(
		'UPDATE auth_oauth_grant_revocation SET "revokedAt"=to_timestamp($1) WHERE "userId"=$2 AND "clientId"=$3',
		[now - 20, caller.userId, clientId],
	);
	await consume();
	await revokeAuthorizedClient(caller.userId, consentId);
	await expect(consume()).rejects.toMatchObject({
		name: "McpCredentialInactiveError",
	});
});
it("real signed JWTs enforce signature, issuer, audience, expiry, scopes and live grant/user revocation through native MCP", async () => {
	const { clientId, consentId } = await seed();
	const claims = {
		sub: "native-user",
		azp: clientId,
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 300,
		iss: `${origin}/api/auth`,
		aud: `${origin}/api/mcp`,
		scope: "nova.read nova.write",
	};
	const sign = async (payload: Record<string, unknown>) =>
		(await auth.api.signJWT({ body: { payload } })).token;
	const token = await sign(claims);
	const accepted = await call(token);
	expect(
		accepted.status,
		JSON.stringify({
			headers: Object.fromEntries(accepted.headers),
			text: accepted.text,
			jwksReads,
		}),
	).toBe(200);
	const data =
		accepted.text
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6) ?? accepted.text;
	expect(JSON.parse(data)).toMatchObject({
		jsonrpc: "2.0",
		id: 7,
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						userId: "native-user",
						scopes: ["nova.read", "nova.write"],
						authKind: "oauth",
						// Project data reads lock this verified token's grant.
						grant: {
							kind: "oauth",
							clientId,
							issuedAt: claims.iat,
							expiresAt: claims.exp,
							scopes: ["nova.read", "nova.write"],
						},
					}),
				},
			],
		},
	});
	expect(jwksReads).toBeGreaterThan(0);
	const parts = token.split(".");
	parts[2] = `${parts[2]?.[0] === "a" ? "b" : "a"}${parts[2]?.slice(1)}`;
	expect((await call(parts.join("."))).status).toBe(401);
	for (const change of [
		{ iss: "https://wrong.example/api/auth" },
		{ aud: "https://wrong.example/mcp" },
		{ exp: Math.floor(Date.now() / 1000) - 60 },
	])
		expect((await call(await sign({ ...claims, ...change }))).status).toBe(401);
	for (const scope of ["nova.read", "nova.write"]) {
		const result = await call(await sign({ ...claims, scope }));
		expect(result.status).toBe(403);
		expect(result.headers.get("www-authenticate")).toContain(
			"insufficient_scope",
		);
	}
	expect((await call(await sign({ ...claims, scope: "" }))).status).toBe(401);
	for (const key of ["sub", "azp", "iat"]) {
		const payload: Record<string, unknown> = { ...claims };
		delete payload[key];

		expect((await call(await sign(payload))).status).toBe(401);
	}
	await dbHandle.pool.query(
		"ALTER TABLE auth_oauth_consent RENAME TO hidden_oauth_consent",
	);
	try {
		/* A consent read that fails is an outage, not a verdict on the token:
		 * the request is still refused, but as a retryable 503 with no Bearer
		 * challenge, so the client keeps a working grant instead of re-running
		 * OAuth over a database blip. */
		const unavailable = await call(token);
		expect(unavailable.status).toBe(503);
		expect(unavailable.headers.get("www-authenticate")).toBeNull();
		expect(unavailable.headers.get("retry-after")).toBe("5");
	} finally {
		await dbHandle.pool.query(
			"ALTER TABLE hidden_oauth_consent RENAME TO auth_oauth_consent",
		);
	}
	await dbHandle.pool.query(
		"UPDATE auth_user SET banned = true WHERE id = $1",
		["native-user"],
	);
	expect((await call(token)).headers.get("www-authenticate")).toContain(
		"account disabled",
	);
	await dbHandle.pool.query(
		"UPDATE auth_user SET banned = false WHERE id = $1",
		["native-user"],
	);
	const { revokeAuthorizedClient } = await import("@/lib/db/oauth-consents");
	await revokeAuthorizedClient("native-user", consentId);
	const revoked = await call(token);
	expect(revoked.status).toBe(401);
	expect(revoked.headers.get("www-authenticate")).toContain("consent revoked");
	expect(revoked.headers.get("www-authenticate")).toContain(
		"resource_metadata=",
	);
});
it("production Better Auth MCP middleware persists the IP counter and atomically admits only the last concurrent request at its cap", async () => {
	for (let i = 0; i < 119; i++)
		expect(
			(await call("sk-nova-v1-invalid-key-for-native-rate-limit")).status,
		).toBe(401);
	const boundary = await Promise.all([
		call("sk-nova-v1-invalid-key-for-native-rate-limit"),
		call("sk-nova-v1-invalid-key-for-native-rate-limit"),
		call("sk-nova-v1-invalid-key-for-native-rate-limit"),
	]);
	expect(boundary.map((response) => response.status).sort()).toEqual([
		401, 429, 429,
	]);
	const blocked = await call("sk-nova-v1-invalid-key-for-native-rate-limit");
	expect(blocked.status).toBe(429);
	expect(Number(blocked.headers.get("x-retry-after"))).toBeGreaterThan(0);
	expect(
		(await call("sk-nova-v1-invalid-key-for-native-rate-limit", "192.0.2.46"))
			.status,
	).toBe(401);
	const rows = await dbHandle.pool.query(
		"SELECT key, count FROM auth_rate_limit",
	);
	expect(rows.rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: expect.stringContaining("192.0.2.45"),
				count: 120,
			}),
		]),
	);
});
