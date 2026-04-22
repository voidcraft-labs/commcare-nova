/**
 * Smoke test: can better-auth-firestore run the @better-auth/oauth-provider schema?
 *
 * Instantiates a Better Auth server with jwt() + oauthProvider() pointed at
 * temp-prefixed Firestore collections, then drives it via in-process HTTP
 * Requests. Exercises:
 *   1. AS-metadata GET — probes the bare `/.well-known/oauth-authorization-server`
 *      path. A 404 here is the EXPECTED result and confirms RFC 8414 path
 *      insertion is in effect: with an issuer of `http://localhost:3000/api/auth`,
 *      the plugin registers metadata at `/.well-known/oauth-authorization-server/api/auth`
 *      (the issuer path is inserted AFTER the well-known segment, not prefixed
 *      before it). Better Auth logs a warning that names the exact path.
 *      A 2xx here would mean the plugin registered the bare path too — also fine,
 *      just different.
 *   2. POST /oauth2/register with public-client DCR body — proves the Firestore
 *      adapter can write to the `oauthClient` collection and that the plugin
 *      honors allowDynamicClientRegistration + allowUnauthenticatedClientRegistration.
 *      A 200 response exercises create(oauthClient) and (implicitly) the
 *      uniqueness-check findUnique(oauthClient, { clientId }).
 *   3. POST /oauth2/introspect with a bogus token — only confirms the endpoint
 *      is registered and the plugin boots without crashing. It does NOT exercise
 *      the token-read path: the plugin rejects with `invalid_client` at the
 *      client-auth layer before touching `oauthAccessToken`. Verifying the
 *      findUnique/delete on token tables requires a real auth-code → token
 *      exchange with a client that presents valid credentials.
 *
 * Logs status per step so the audit table can be filled in.
 *
 * Run with: npx tsx scripts/verify-oauth-adapter.mts
 *
 * FUTURE NOTE: once `oauthProvider()` is wired into `lib/auth.ts` for real,
 * future re-runs of this kind of verification should prefer importing the real
 * `auth` (via `getAuth()`) and driving it with `auth.handler(req)` rather than
 * re-constructing a parallel Better Auth instance here. The parallel instance
 * will drift from production config (scopes, valid audiences, trusted clients,
 * login/consent page paths, JWT signing strategy) the moment any of those move.
 * This script re-constructs the config only because B1 runs BEFORE `lib/auth.ts`
 * has the plugin wired — there's no production `auth` to import yet.
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

/* Require a real secret. Better Auth enforces >=32 chars in production but is
 * forgiving in dev; this script always talks to real Firestore, so we insist
 * too. Refusing to bake a literal "secret-looking" string into the repo also
 * avoids accidental copy-paste into a real deploy. */
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) {
	console.error(
		"BETTER_AUTH_SECRET must be set to a string of at least 32 characters. " +
			"Generate one with `openssl rand -base64 32` and re-run.",
	);
	process.exit(1);
}

const prefix = `verify_oauth_${Date.now()}_`;

const auth = betterAuth({
	secret,
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
	/* Probe the bare `/.well-known/oauth-authorization-server` path. The plugin
	 * registers its metadata route via RFC 8414 path insertion: the issuer's
	 * path suffix (`/api/auth` here, from baseURL) is inserted AFTER the
	 * well-known segment, so the real route is
	 * `/.well-known/oauth-authorization-server/api/auth`. A 404 here is the
	 * expected signal that path insertion is in effect — Better Auth even
	 * prints the exact expected path in its warning. Any non-404 is noted
	 * below for human inspection. */
	await call(
		"AS metadata (bare path — 404 expected, see RFC 8414 path insertion)",
		new Request("http://localhost:3000/.well-known/oauth-authorization-server"),
	);

	/* DCR creates a real `oauthClient` document at the Firestore root.
	 * `firestoreAdapter`'s `collections:` option only remaps the four core
	 * Better Auth tables — plugin-owned tables use their default names and
	 * ignore the `verify_oauth_*` prefix this script sets. We read the
	 * `client_id` from the response so we can clean up the leaked doc at
	 * the end of the run. */
	const dcrResponse = await call(
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

	await cleanupDcrClient(dcrResponse);

	console.log("\nDone. Inspect output, then fill the audit table.");
}

/**
 * Delete the `oauthClient` document that DCR wrote to Firestore.
 *
 * Better Auth's adapter stores clients under a doc keyed by an internal row id
 * (NOT the OAuth `clientId`), and exposes `clientId` as a queryable field. So
 * cleanup is a where-query + delete rather than a direct doc().delete() on the
 * response's `client_id`. Wrapped in try/catch so a cleanup failure surfaces
 * in the log but never masks a failing run — the exit code still reflects the
 * actual verification, not the janitor.
 */
async function cleanupDcrClient(dcrResponse: Response | null): Promise<void> {
	if (!dcrResponse?.ok) {
		console.log("\n[cleanup] Skipped — DCR did not return a client to remove.");
		return;
	}
	try {
		const body = (await dcrResponse.clone().json()) as { client_id?: string };
		const clientId = body.client_id;
		if (!clientId) {
			console.log("\n[cleanup] DCR response missing client_id; skipping.");
			return;
		}
		const snap = await db
			.collection("oauthClient")
			.where("clientId", "==", clientId)
			.get();
		if (snap.empty) {
			console.log(
				`\n[cleanup] No oauthClient doc found for clientId=${clientId}.`,
			);
			return;
		}
		await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
		console.log(
			`\n[cleanup] Deleted ${snap.size} oauthClient doc(s) for clientId=${clientId}.`,
		);
	} catch (err) {
		console.log(`\n[cleanup] FAILED (continuing): ${String(err)}`);
	}
}

run().catch((e) => {
	console.error("\nFAIL:", e);
	process.exit(1);
});
