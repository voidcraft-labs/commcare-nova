import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	type FetchLike,
	IssuerMismatchError,
} from "@modelcontextprotocol/client";
import { getMigrations } from "better-auth/db/migration";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { GET as insertedOAuth } from "@/app/.well-known/oauth-authorization-server/api/auth/route";
import { GET as rootOAuth } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as resourceMetadata } from "@/app/.well-known/oauth-protected-resource/[...path]/route";
import { GET as insertedOidc } from "@/app/.well-known/openid-configuration/api/auth/route";
import { GET as rootOidc } from "@/app/.well-known/openid-configuration/route";
import { GET as authRoute } from "@/app/api/auth/[...all]/route";
import * as authModule from "@/lib/auth";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	AS_ISSUER,
	AS_ORIGIN,
	MCP_RESOURCE_METADATA_URL,
	MCP_RESOURCE_URL,
} from "@/lib/hostnames";
import { proxy } from "@/proxy";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_discovery_",
	schema: "migrated",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("lets a strict MCP client discover the canonical issuer through the public host policy", async () => {
	vi.stubEnv(
		"BETTER_AUTH_SECRET",
		"native-discovery-secret-at-least-32-characters",
	);
	vi.stubEnv("BETTER_AUTH_URL", AS_ORIGIN);
	const auth = authModule.createAuth(database.pool);
	vi.spyOn(authModule, "getAuth").mockResolvedValue(auth);
	const context = await auth.$context;
	await context.checkSchema?.();

	// Only transport dispatch is controlled. The real SDK chooses each URL and
	// validates issuer equality; proxy, route modules and Better Auth produce
	// their actual responses. This does not replace the served Next route check.
	const routes = new Map<string, (request: Request) => Promise<Response>>([
		["/.well-known/oauth-protected-resource/mcp", resourceMetadata],
		["/.well-known/oauth-protected-resource", resourceMetadata],
		["/.well-known/oauth-authorization-server", rootOAuth],
		["/.well-known/oauth-authorization-server/api/auth", insertedOAuth],
		["/.well-known/openid-configuration", rootOidc],
		["/.well-known/openid-configuration/api/auth", insertedOidc],
		["/api/auth/.well-known/openid-configuration", authRoute],
		["/api/auth/.well-known/oauth-authorization-server", authRoute],
	]);
	const requested: string[] = [];
	const unavailable = new Set<string>();
	const fetchRoutes: FetchLike = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		requested.push(request.url);
		request.headers.set("host", url.host);
		const boundary = proxy(new NextRequest(request));
		if (boundary.status !== 200) return boundary;
		expect(boundary.headers.get("x-middleware-next")).toBe("1");
		expect(boundary.headers.get("content-security-policy")).toBeNull();
		if (unavailable.has(url.pathname))
			return new Response(null, { status: 404 });
		return (
			routes.get(url.pathname)?.(request) ?? new Response(null, { status: 404 })
		);
	};

	const discovery = await discoverOAuthServerInfo(MCP_RESOURCE_URL, {
		resourceMetadataUrl: new URL(MCP_RESOURCE_METADATA_URL),
		fetchFn: fetchRoutes,
	});
	expect(discovery.authorizationServerUrl).toBe(AS_ISSUER);
	expect(discovery.resourceMetadata?.authorization_servers).toEqual([
		AS_ISSUER,
	]);
	expect(discovery.authorizationServerMetadata?.issuer).toBe(AS_ISSUER);
	expect(discovery.authorizationServerMetadata?.token_endpoint).toBe(
		`${AS_ISSUER}/oauth2/token`,
	);
	expect(requested).toEqual([
		MCP_RESOURCE_METADATA_URL,
		`${AS_ORIGIN}/.well-known/oauth-authorization-server/api/auth`,
	]);

	// Keep old origin-probing clients' documents; never change their issuer to
	// make a strict client accept the formerly incorrect resource advertisement.
	for (const path of [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
	]) {
		const response = await fetchRoutes(`${AS_ORIGIN}${path}`);
		expect((await response.json()).issuer).toBe(AS_ISSUER);
	}
	await expect(
		discoverAuthorizationServerMetadata(AS_ORIGIN, { fetchFn: fetchRoutes }),
	).rejects.toBeInstanceOf(IssuerMismatchError);

	// Both standard OIDC fallback locations remain reachable and retain the
	// same identity when an OAuth metadata response is temporarily unavailable.
	unavailable.add("/.well-known/oauth-authorization-server/api/auth");
	for (const expectedPath of [
		"/.well-known/openid-configuration/api/auth",
		"/api/auth/.well-known/openid-configuration",
	]) {
		requested.length = 0;
		const metadata = await discoverAuthorizationServerMetadata(AS_ISSUER, {
			fetchFn: fetchRoutes,
		});
		expect(metadata?.issuer).toBe(AS_ISSUER);
		expect(requested.at(-1)).toBe(`${AS_ORIGIN}${expectedPath}`);
		unavailable.add(expectedPath);
	}

	// Serving metadata must not widen the MCP host into an authorization server.
	const wrongHost = await fetchRoutes(
		"https://mcp.commcare.app/.well-known/oauth-authorization-server/api/auth",
	);
	expect(wrongHost.status).toBe(404);
	await wrongHost.body?.cancel();
});
