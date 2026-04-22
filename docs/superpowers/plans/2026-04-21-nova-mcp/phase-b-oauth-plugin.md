# Phase B — Better Auth OAuth plugin

**Goal:** Turn Nova's existing Better Auth instance into a full OAuth 2.1 authorization server. Add `jwt()` + `oauthProvider()`, publish well-known metadata, build the consent page. No custom AS code.

**Dependencies:** Phase A (the proxy.ts hostname allowlists already include `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/consent` on the main host and `/.well-known/oauth-protected-resource` on the MCP host — see `lib/hostnames.ts`).

**Already done in commit `98accb5`** (the dep-prep work that used to be Step 1 of Task B1 below):
- `better-auth` bumped to `^1.6.6` (which uses `better-call@1.3.5`).
- `patches/better-call+1.3.2.patch`, the `patch-package` devDep, and the `postinstall` script all removed — the bug they patched is fixed natively in `better-call@1.3.5`.
- `@better-auth/oauth-provider ^1.6.6`, `mcp-handler ^1.1.0`, and `@modelcontextprotocol/sdk ^1.26.0` added to `dependencies`. (mcp-handler peer-pins the SDK to exact `1.26.0`, so caret on the SDK is purely cosmetic — the resolver will keep them in lockstep.)
- `"vite": "^8.0.0"` added to the `overrides` block. Required because `better-auth@1.6.x` declares `peerOptional @sveltejs/kit ^2.0.0` and npm 11 walks optional-peer chains eagerly: it tries to satisfy kit's transitive `vite-plugin-svelte` peer, which conflicts with the `vite` version `vitest` pulls in (8.0.9). The override forces the resolver to reuse our existing vite instead of speculating. We are not a Svelte project; the chain only exists because of the speculative walk.

If a future better-auth bump removes the `peerOptional @sveltejs/kit` declaration, the vite override may become removable. Until then, leave it.

---

## Task B1: Verify Firestore adapter compatibility (load-bearing research)

This is the single biggest unknown in the plan — if `better-auth-firestore` can't run the `@better-auth/oauth-provider` schema, the whole phase pivots.

**Files:**
- Create: `scripts/verify-oauth-adapter.ts`
- Create: `docs/superpowers/plans/notes/2026-04-21-nova-mcp-adapter-audit.md`

- [ ] **Step 1: Confirm deps are installed**

`npm ls @better-auth/oauth-provider mcp-handler @modelcontextprotocol/sdk` should show all three resolved. If not, see commit `98accb5` for the install incantation (caret ranges, vite override, drop patch-package). Do NOT use `--save-exact` — pinning forces the resolver into corner cases like the `peerOptional @sveltejs/kit` chain that the override defuses.

- [ ] **Step 2: Query context7 for plugin docs**

Use `mcp__context7__resolve-library-id` + `mcp__context7__query-docs` to fetch `@better-auth/oauth-provider` documentation — specifically the schema requirements for the four new tables (`oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`) and the adapter hooks it invokes. Also fetch `better-auth-firestore` docs.

- [ ] **Step 3: Write the audit skeleton**

Create `docs/superpowers/plans/notes/2026-04-21-nova-mcp-adapter-audit.md`:

```markdown
# OAuth-provider × Firestore adapter audit

| Hook | Adapter support | Notes |
|---|---|---|
| create(oauthClient, ...) | ? | |
| findUnique(oauthClient, { clientId }) | ? | |
| update(oauthClient, { client_secret_hash, client_secret_expires_at }) | ? | Secret rotation |
| findUnique(oauthRefreshToken, { token_hash }) | ? | |
| delete(oauthRefreshToken, { token_hash }) | ? | Revocation |
| findUnique(oauthConsent, { userId_clientId }) | ? | Compound key |
| create(oauthConsent) inside transaction | ? | Transactional consent writes |
| findMany(oauthAccessToken, { userId }) | ? | Admin revocation listing |

For any "no", either contribute the hook upstream or keep OAuth tables on
a different storage engine via the plugin's `storage: { ... }` override
and document why.
```

- [ ] **Step 4: Write the verification script**

The plugin's surface area is mostly HTTP endpoints under `/api/auth/oauth2/*` — the named `auth.api.oauth2.*` methods that earlier drafts of this plan assumed do not exist as a stable programmatic API. Drive the plugin via `auth.handler(req)` with real `Request` objects so we hit whatever routes the plugin actually registered, regardless of method-name churn.

```ts
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
 * Run with: npx tsx scripts/verify-oauth-adapter.ts
 */

import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { firestoreAdapter } from "better-auth-firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "@/lib/db/firestore";

const prefix = `verify_oauth_${Date.now()}_`;

const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-min-32-chars-long-padding",
	baseURL: "http://localhost:3000",
	database: firestoreAdapter({
		firestore: getDb() as unknown as Firestore,
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
			scopes: ["openid", "profile", "email", "offline_access", "nova.read", "nova.write"],
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
```

- [ ] **Step 5: Run it**

Run: `npx tsx scripts/verify-oauth-adapter.ts`
Expected: "DCR ok: true", "AS metadata ok: true". Any adapter-level crash means the Firestore adapter is incompatible and this phase must pivot.

- [ ] **Step 6: Fill in the audit table**

Based on what the verification exercised, mark each row pass/fail/unknown in the audit markdown.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-oauth-adapter.ts docs/superpowers/plans/notes/2026-04-21-nova-mcp-adapter-audit.md
git commit -m "chore(mcp): smoke-test Firestore adapter against oauth-provider"
```

Deps are already installed in commit `98accb5`; this commit is just the script and the audit doc.

---

## Task B2: Wire OAuth provider + JWT plugins

**Files:**
- Modify: `lib/auth.ts`

- [ ] **Step 1: Edit `lib/auth.ts`**

Add imports at the top:

```ts
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
```

Add `disabledPaths: ["/token"]` at the TOP LEVEL of the `betterAuth({...})` call (sibling of `plugins`, not inside them) — required when pairing with `oauth-provider` so the legacy `/token` endpoint doesn't collide with `/oauth2/token`. Per Better Auth's own docs, this is MANDATORY when running OAuth/OIDC/MCP mode.

Replace the `plugins: [admin({ ... })]` block with:

```ts
plugins: [
	admin({
		adminUserIds:
			process.env.ADMIN_USER_IDS?.split(",").filter(Boolean) ?? [],
	}),

	/**
	 * JWT plugin — exposes /api/auth/jwks. The oauth-provider plugin
	 * signs access tokens with these keys; the MCP handler verifies
	 * bearer tokens against the same JWKS.
	 *
	 * `disableSettingJwtHeader: true` is REQUIRED when running in
	 * OAuth/OIDC/MCP mode per Better Auth docs — without it the JWT
	 * middleware tries to attach bearer tokens to every request,
	 * breaking session-cookie flows.
	 */
	jwt({ disableSettingJwtHeader: true }),

	/**
	 * OAuth 2.1 authorization server. Turns Better Auth into a full
	 * OAuth-AS for programmatic clients (Claude Code and any other
	 * MCP consumer). Session-cookie auth on commcare.app is unaffected
	 * — this plugin adds NEW endpoints under /api/auth and /oauth2, and
	 * emits new .well-known metadata, without touching the existing
	 * login flow.
	 *
	 * Per-endpoint rate limiting is handled by the plugin's defaults —
	 * keep them. This is the only rate-limiting surface the MCP feature
	 * introduces; tool calls inherit Nova's existing convention of
	 * authenticated-only, no app-level limits.
	 */
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
		clientRegistrationDefaultScopes: [
			"openid",
			"profile",
			"email",
			"offline_access",
			"nova.read",
			"nova.write",
		],
		clientRegistrationClientSecretExpiration: "30d",
	}),
],
```

- [ ] **Step 2: Generate schema**

Run: `npx @better-auth/cli generate --config lib/auth.ts`
Expected: CLI prints the four new collections. No migration file (Firestore is schema-agnostic); collections materialize on first write.

- [ ] **Step 3: Smoke-test**

Start dev: `npm run dev` (foreground in another terminal; do not block this task on it).

```bash
curl -s http://localhost:3000/api/auth/jwks | head -c 200
```
Expected: JSON with a `keys` array.

- [ ] **Step 4: Commit**

```bash
git add lib/auth.ts
git commit -m "feat(mcp): enable oauth-provider + jwt plugins on Better Auth"
```

---

## Task B3: OAuth-AS + OIDC metadata routes

**Files:**
- Create: `app/.well-known/oauth-authorization-server/route.ts`
- Create: `app/.well-known/openid-configuration/route.ts`

**Critical: lazy-bind `getAuth()`.** The plan as originally drafted called `getAuth()` at module load (`export const GET = oauthProviderAuthServerMetadata(getAuth())`). That breaks `next build`, which imports route modules during page collection — `lib/auth.ts` is intentionally lazy via `getAuth()` so the Firestore connection and env-var reads don't run at build time. Mirror the pattern from `app/api/auth/[...all]/route.ts`: wrap the helper in a request-time closure.

- [ ] **Step 1: Write `oauth-authorization-server/route.ts`**

```ts
/**
 * OAuth 2.1 authorization server metadata (RFC 8414).
 *
 * Served only on commcare.app (proxy.ts allowlists this path on the main host).
 * Claude Code and other MCP clients read this endpoint to discover the
 * token / authorization / registration endpoints for the OAuth flow.
 *
 * The handler is wrapped in a request-time closure so `getAuth()` runs on
 * first request, not at module-load. `next build` imports this route during
 * page collection — eager `getAuth()` would force Firestore + secret-env
 * reads at build time and fail. Same pattern as app/api/auth/[...all]/route.ts.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oauthProviderAuthServerMetadata(getAuth())(req);
```

- [ ] **Step 2: Write `openid-configuration/route.ts`**

```ts
/**
 * OpenID Connect discovery document. Lazy-bound for the same build-time
 * reason as the AS-metadata route. Published on commcare.app only.
 */

import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oauthProviderOpenIdConfigMetadata(getAuth())(req);
```

- [ ] **Step 3: Smoke + capture the actual JWKS URL**

With dev running:

```bash
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq .jwks_uri
```

The plan hardcodes `https://commcare.app/api/auth/jwks` in Phase G. If the actual `jwks_uri` differs, record the real value in `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md` and update Phase G's `jwksUrl` accordingly BEFORE implementing the route handler.

- [ ] **Step 4: Commit**

```bash
git add app/.well-known/oauth-authorization-server/route.ts app/.well-known/openid-configuration/route.ts
git commit -m "feat(mcp): publish OAuth-AS + OIDC discovery metadata"
```

---

## Task B4: Protected-resource metadata route (one-line helper)

**Files:**
- Create: `app/.well-known/oauth-protected-resource/route.ts`

Better Auth ships `oAuthProtectedResourceMetadata(auth)` from `better-auth/plugins` — a one-liner that emits the RFC 9728 document. The heavier `oauthProviderResourceClient` + `createAuthClient` path is for separate-process resource servers that can't import the auth instance directly; we have an in-process Next.js app, so the one-liner is the canonical path. No `lib/server-client.ts` needed.

- [ ] **Step 1: Write `app/.well-known/oauth-protected-resource/route.ts`**

```ts
/**
 * OAuth 2.0 protected-resource metadata (RFC 9728).
 *
 * Served ONLY on mcp.commcare.app (proxy.ts allowlists this path on the MCP
 * host; on the main host it falls through to a 404). Claude Code fetches
 * this URL on its first attempt to call an MCP tool; the response points
 * it at commcare.app as the authorization server, which it then discovers
 * via /.well-known/oauth-authorization-server.
 *
 * Lazy-bound for the same build-time reason as the AS-metadata routes.
 */

import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oAuthProtectedResourceMetadata(getAuth())(req);
```

- [ ] **Step 2: Smoke**

With dev running:

```bash
curl -s -H "Host: mcp.commcare.app" http://localhost:3000/.well-known/oauth-protected-resource | jq .
```
Expected: JSON with `resource` and `authorization_servers` fields pointing at `https://mcp.commcare.app` and `https://commcare.app` respectively. If the default helper output doesn't match those values, check the plugin docs for a config object arg — some versions take `{ resource, authorization_servers }`.

```bash
curl -s -H "Host: commcare.app" -w "%{http_code}\n" http://localhost:3000/.well-known/oauth-protected-resource
```
Expected: `404` (middleware blocks — path not on main-app allowlist).

- [ ] **Step 3: Commit**

```bash
git add app/.well-known/oauth-protected-resource/route.ts
git commit -m "feat(mcp): publish protected-resource metadata via oAuthProtectedResourceMetadata helper"
```

---

## Task B5: Consent page

**Files:**
- **Modify:** `lib/auth-client.ts` (it already exists with `inferAdditionalFields<Auth>()` + `adminClient()` + `sessionOptions: { refetchOnWindowFocus: false }` — extend, don't overwrite)
- Create: `app/consent/page.tsx`
- Create: `app/consent/ConsentForm.tsx`

- [ ] **Step 1: Extend `lib/auth-client.ts`**

Add `oauthProviderClient()` to the existing plugins array. Preserve every other line.

```ts
/**
 * Browser-side Better Auth client.
 *
 * `inferAdditionalFields<Auth>()` infers any custom session/user fields from
 * the server config. `adminClient()` adds type definitions and methods for
 * the admin plugin. `oauthProviderClient()` adds `authClient.oauth2.consent`
 * so the consent page can POST the accept/deny choice through the typed
 * client rather than hand-rolling the fetch.
 *
 * Session refetch on window focus is disabled — see lib/auth-client.ts for
 * the reasoning (Better Auth's default briefly nulls session data on tab
 * switch, which would race with client-side auth checks).
 */

import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "./auth";

export const authClient = createAuthClient({
	plugins: [inferAdditionalFields<Auth>(), adminClient(), oauthProviderClient()],
	sessionOptions: {
		refetchOnWindowFocus: false,
	},
});
```

- [ ] **Step 2: Write `app/consent/ConsentForm.tsx`**

```tsx
/**
 * Consent form — renders the requested scopes and hands approve/deny
 * decisions back to Better Auth's oauth-provider plugin. Keeps all
 * interactive state on the client; the RSC shell hydrates the initial
 * view with client name + scope list.
 */

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

interface ConsentFormProps {
	clientName: string;
	scopes: readonly string[];
	redirectMismatch: boolean;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
	openid: "Identify you to the app",
	profile: "See your name",
	email: "See your email",
	offline_access: "Stay signed in when you're not using it",
	"nova.read": "Read your CommCare apps",
	"nova.write": "Create, edit, and deploy CommCare apps on your behalf",
};

export function ConsentForm({
	clientName,
	scopes,
	redirectMismatch,
}: ConsentFormProps) {
	const [pending, setPending] = useState<"accept" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (redirectMismatch) {
		return (
			<p className="text-red-500">
				Authorization request invalid or expired. Start again from the app
				that initiated sign-in.
			</p>
		);
	}

	const submit = async (accept: boolean) => {
		setPending(accept ? "accept" : "deny");
		setError(null);
		const { error: err } = await authClient.oauth2.consent({ accept });
		if (err) {
			setError(err.message ?? "Consent failed.");
			setPending(null);
		}
		/* Success: plugin redirects the user back to the client's
		 * redirect_uri with an authorization_code — no client-side
		 * navigation needed here. */
	};

	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">
				Allow {clientName} to access your account?
			</h1>
			<ul className="flex flex-col gap-2">
				{scopes.map((s) => (
					<li key={s} className="flex gap-2">
						<span className="font-mono text-sm text-zinc-400">{s}</span>
						<span>{SCOPE_DESCRIPTIONS[s] ?? s}</span>
					</li>
				))}
			</ul>
			{error && <p className="text-red-500">{error}</p>}
			<div className="flex gap-3">
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit(true)}
					className="rounded bg-violet-600 px-4 py-2 text-white disabled:opacity-50"
				>
					{pending === "accept" ? "Approving..." : "Allow"}
				</button>
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit(false)}
					className="rounded border border-zinc-700 px-4 py-2 disabled:opacity-50"
				>
					{pending === "deny" ? "Denying..." : "Deny"}
				</button>
			</div>
		</div>
	);
}
```

- [ ] **Step 3: Write `app/consent/page.tsx`**

The plugin redirects users to the consent page with three query parameters: `consent_code`, `client_id`, and `scope` (space-separated). There is no `auth.api.oauth2.getPendingAuthorization` server method (an earlier draft of this plan invented one that doesn't exist). To enrich the display with the client's name we hit the plugin's own `GET /oauth2/public-client` endpoint server-side via `auth.handler`. Note: that endpoint requires an active session, which is fine here because we already gate-redirect to `/sign-in` above.

```tsx
/**
 * OAuth consent page (server component).
 *
 * The oauth-provider plugin redirects authenticated users here with three
 * query parameters: consent_code, client_id, and scope. We render the
 * client name + scope list, then hand the accept/deny decision to a
 * client form that calls authClient.oauth2.consent({ accept }).
 *
 * The form's `accept` POST carries the user's session cookie back to
 * /api/auth/oauth2/consent, which uses the consent_code stashed by the
 * plugin to complete the authorization-code flow and redirect the user
 * back to the OAuth client.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { ConsentForm } from "./ConsentForm";

interface ConsentPageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Parse the space-separated `scope` query param into a deduped list. */
function parseScopes(raw: string | string[] | undefined): string[] {
	if (!raw) return [];
	const flat = Array.isArray(raw) ? raw.join(" ") : raw;
	return Array.from(new Set(flat.split(/\s+/).filter(Boolean)));
}

/**
 * Best-effort fetch of the OAuth client's public name. Returns `undefined`
 * if the client_id is unknown or the plugin endpoint shape changes —
 * the consent page falls back to a generic "An application" label.
 */
async function fetchClientName(
	auth: ReturnType<typeof getAuth>,
	clientId: string,
	hdrs: Headers,
): Promise<string | undefined> {
	try {
		const url = new URL("http://localhost/api/auth/oauth2/public-client");
		url.searchParams.set("client_id", clientId);
		const res = await auth.handler(new Request(url, { headers: hdrs }));
		if (!res.ok) return undefined;
		const body = (await res.json()) as { client_name?: string };
		return body.client_name;
	} catch {
		return undefined;
	}
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
	const sp = await searchParams;
	const auth = getAuth();
	const hdrs = await headers();

	const session = await auth.api.getSession({ headers: hdrs });
	if (!session) redirect("/sign-in");

	const consentCode =
		typeof sp.consent_code === "string" ? sp.consent_code : undefined;
	const clientId = typeof sp.client_id === "string" ? sp.client_id : undefined;
	const scopes = parseScopes(sp.scope);

	/* The query params are required for a valid consent request. Missing or
	 * tampered params mean the user landed here outside an OAuth flow —
	 * surface that to the form so it can render a clear error instead of a
	 * mystery accept button. */
	const requestValid = Boolean(consentCode && clientId && scopes.length > 0);
	const clientName =
		requestValid && clientId
			? (await fetchClientName(auth, clientId, hdrs)) ?? "An application"
			: "An application";

	return (
		<main className="mx-auto max-w-xl p-8">
			<ConsentForm
				clientName={clientName}
				scopes={scopes}
				redirectMismatch={!requestValid}
			/>
		</main>
	);
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit && echo "✓"`
Expected: `✓`.

End-to-end consent verification lands in Phase G Task G3 (requires a deployed staging target to run the full OAuth handshake from a real client). The proxy.ts main-host allowlist already includes `/consent`, so no proxy edit is needed here.

- [ ] **Step 5: Commit**

```bash
git add lib/auth-client.ts app/consent/page.tsx app/consent/ConsentForm.tsx
git commit -m "feat(mcp): OAuth consent page with scope-aware accept/deny"
```
