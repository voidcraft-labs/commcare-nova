/**
 * Resource-server client — surfaces the helpers the MCP endpoint on
 * `mcp.commcare.app` uses to publish RFC 9728 protected-resource metadata
 * and verify bearer tokens against the authorization server.
 *
 * `oauthProviderResourceClient(auth)` is instantiated with Nova's auth
 * so `getProtectedResourceMetadata()` can fill fields from the AS config
 * — `scopes_supported`, `jwks_uri`, and `resource_signing_alg_values_supported`
 * all come from the wired `oauthProvider` plugin rather than being
 * duplicated here. Callers still supply `resource` + `authorization_servers`
 * because those live on a subdomain the AS doesn't know about.
 *
 * The cast at the `oauthProviderResourceClient` call site bridges a
 * nominal TypeScript mismatch: the plugin declares its parameter as the
 * base `Auth` type from `better-auth/types`, but `getAuth()` returns
 * `ReturnType<typeof createAuth>` whose `api` shape is `InferAPI<...>` of
 * our plugin composition (admin + jwt + oauth-provider plus our
 * `user.additionalFields`). The two are structurally compatible at runtime
 * — the plugin only calls methods it declares — so the widening is safe.
 *
 * Lazy-constructed behind `getServerClient()` (async) for the same reason
 * `getAuth()` is lazy + async: Next imports server modules during `next build`'s
 * page collection, and eager construction would force the Postgres pool + env
 * reads before they're available.
 */

import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient } from "better-auth/client";
import type { Auth } from "better-auth/types";
import { getAuth } from "@/lib/auth";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

async function createServerClient() {
	const auth = await getAuth();
	return createAuthClient({
		plugins: [oauthProviderResourceClient(auth as unknown as Auth)],
	});
}

let cached: ServerClient | null = null;
let inFlight: Promise<ServerClient> | null = null;

export async function getServerClient(): Promise<ServerClient> {
	if (cached) return cached;
	if (inFlight === null) {
		inFlight = createServerClient();
		try {
			cached = await inFlight;
		} finally {
			inFlight = null;
		}
		return cached;
	}
	return inFlight;
}
