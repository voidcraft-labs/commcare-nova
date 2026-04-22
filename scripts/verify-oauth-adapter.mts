/**
 * Smoke test: can better-auth-firestore run the @better-auth/oauth-provider schema?
 *
 * Instantiates a Better Auth server with jwt() + oauthProvider() pointed at
 * temp-prefixed Firestore collections, then drives it via in-process HTTP
 * Requests. Exercises:
 *   1. AS-metadata GET — proves the plugin booted and metadata renders.
 *   2. POST /oauth2/register with public-client DCR body — proves the adapter
 *      can write to oauthApplication and the plugin honors
 *      allowDynamicClientRegistration + allowUnauthenticatedClientRegistration.
 *   3. POST /oauth2/introspect with a bogus token — should 200 with active:false
 *      or a clean 4xx; either is fine. Crash means oauthAccessToken read is broken.
 *
 * Logs status per step so the audit table can be filled in.
 *
 * Run with: npx tsx scripts/verify-oauth-adapter.mts
 *
 * Deviations from the Phase B1 plan body (see the adapter-audit doc for detail):
 *   - File extension `.mts` (not `.ts`) — better-auth-firestore@1.1.4 declares
 *     an `exports.require` path at `./dist/index.cjs` that isn't shipped, and
 *     the project root lacks `"type":"module"`, so tsx loads a plain `.ts`
 *     script as CJS and the package resolver dies. `.mts` pins the entry to
 *     ESM, which routes through the `import` condition that actually resolves.
 *   - `getDb()` from `@/lib/db/firestore` is inlined — importing it from an
 *     ESM entry still fails because tsx compiles `.ts` dependencies as CJS,
 *     and ESM→CJS named imports crash on esbuild's cjs-module-lexer output.
 *     The inline construction is identical to the singleton in lib/db/firestore.ts.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { Firestore as GoogleFirestore } from "@google-cloud/firestore";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import type { Firestore } from "firebase-admin/firestore";

/* Mirrors getDb() in lib/db/firestore.ts: preferRest avoids gRPC channel
 * hangs when ADC isn't present, and ignoreUndefinedProperties keeps the
 * sentinel-to-undefined post-processing elsewhere in the codebase happy. */
const db = new GoogleFirestore({
	projectId: process.env.GOOGLE_CLOUD_PROJECT,
	ignoreUndefinedProperties: true,
	preferRest: true,
});

const prefix = `verify_oauth_${Date.now()}_`;

const auth = betterAuth({
	secret:
		process.env.BETTER_AUTH_SECRET ?? "dev-secret-min-32-chars-long-padding",
	baseURL: "http://localhost:3000",
	database: firestoreAdapter({
		firestore: db as unknown as Firestore,
		collections: {
			users: `${prefix}users`,
			sessions: `${prefix}sessions`,
			accounts: `${prefix}accounts`,
			verificationTokens: `${prefix}verifications`,
		},
	}),
	disabledPaths: ["/token"],
	plugins: [
		jwt({ disableSettingJwtHeader: true }),
		oauthProvider({
			loginPage: "/sign-in",
			consentPage: "/consent",
			validAudiences: ["https://mcp.commcare.app"],
			scopes: [
				"openid",
				"profile",
				"email",
				"offline_access",
				"nova.read",
				"nova.write",
			],
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
		}),
	],
});

async function call(label: string, req: Request) {
	try {
		const res = await auth.handler(req);
		const text = await res.clone().text();
		console.log(`\n[${label}] HTTP ${res.status}`);
		console.log(text.length > 400 ? `${text.slice(0, 400)}…` : text);
		return res;
	} catch (e) {
		console.log(`\n[${label}] THREW: ${String(e)}`);
		return null;
	}
}

async function run() {
	/* The metadata endpoint may be served at either /api/auth/.well-known/...
	 * or /.well-known/... depending on how the plugin registers routes. The
	 * Phase B3 implementation uses the standalone helper at the root path,
	 * but the plugin also exposes one under /api/auth — try the root first. */
	await call(
		"AS metadata",
		new Request("http://localhost:3000/.well-known/oauth-authorization-server"),
	);

	await call(
		"DCR (public client)",
		new Request("http://localhost:3000/api/auth/oauth2/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "verify",
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				scope: "openid nova.read nova.write",
			}),
		}),
	);

	await call(
		"Introspect bogus token",
		new Request("http://localhost:3000/api/auth/oauth2/introspect", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "token=bogus&token_type_hint=access_token",
		}),
	);

	console.log("\nDone. Inspect output, then fill the audit table.");
}

run().catch((e) => {
	console.error("\nFAIL:", e);
	process.exit(1);
});
