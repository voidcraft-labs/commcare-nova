# Phase B — Better Auth OAuth plugin

**Goal:** Turn Nova's existing Better Auth instance into a full OAuth 2.1 authorization server. Add `jwt()` + `oauthProvider()`, publish well-known metadata, build the consent page. No custom AS code.

**Dependencies:** Phase A (middleware must gate the well-known paths correctly).

---

## Task B1: Verify Firestore adapter compatibility (load-bearing research)

This is the single biggest unknown in the plan — if `better-auth-firestore` can't run the `@better-auth/oauth-provider` schema, the whole phase pivots.

**Files:**
- Create: `scripts/verify-oauth-adapter.ts`
- Create: `docs/superpowers/plans/notes/2026-04-21-nova-mcp-adapter-audit.md`

- [ ] **Step 1: Install deps**

```bash
npm install --save-exact @better-auth/oauth-provider@latest mcp-handler@latest @modelcontextprotocol/sdk@latest
```

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

```ts
/**
 * Smoke test: can better-auth-firestore run the four oauth-provider tables?
 *
 * Instantiates a Better Auth server with jwt() + oauthProvider(), points it
 * at a temporary collection prefix, and exercises: client registration via
 * DCR, authorization-server-metadata read, introspect on a bogus token.
 * Prints a pass/fail per step.
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
	secret: process.env.BETTER_AUTH_SECRET ?? "dev",
	database: firestoreAdapter({
		firestore: getDb() as unknown as Firestore,
		collections: {
			users: `${prefix}users`,
			sessions: `${prefix}sessions`,
			accounts: `${prefix}accounts`,
			verificationTokens: `${prefix}verifications`,
		},
	}),
	plugins: [
		jwt(),
		oauthProvider({
			loginPage: "/sign-in",
			consentPage: "/consent",
			validAudiences: ["https://mcp.commcare.app"],
			scopes: ["openid", "nova.read", "nova.write"],
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
		}),
	],
});

async function run() {
	/* 1. DCR */
	const dcr = await auth.api.oauth2.dynamicClientRegistration({
		body: {
			redirect_uris: ["http://localhost:9999/cb"],
			client_name: "verify",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
		},
	});
	console.log("DCR ok:", !!dcr.client_id);

	/* 2. Metadata endpoints respond */
	const asMeta = await auth.api.oauth2.authServerMetadata();
	console.log("AS metadata ok:", !!asMeta.issuer);

	/* 3. Introspect / revoke on a fake token should 4xx cleanly */
	try {
		await auth.api.oauth2.introspect({ body: { token: "bogus" } });
		console.log("introspect ok");
	} catch (e) {
		console.log("introspect error (expected for bogus token):", String(e));
	}

	console.log("\nAll adapter hooks reachable. Review written docs for structure.");
}

run().catch((e) => {
	console.error("FAIL:", e);
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
git add package.json package-lock.json scripts/verify-oauth-adapter.ts docs/superpowers/plans/notes/2026-04-21-nova-mcp-adapter-audit.md
git commit -m "chore(mcp): install oauth-provider + mcp deps; audit Firestore adapter"
```

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

- [ ] **Step 1: Write `oauth-authorization-server/route.ts`**

```ts
/**
 * OAuth 2.1 authorization server metadata (RFC 8414).
 *
 * Served only on commcare.app (middleware enforces). Claude Code and other
 * MCP clients read this endpoint to discover token/authorization/
 * registration endpoints for the OAuth flow.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = oauthProviderAuthServerMetadata(getAuth());
```

- [ ] **Step 2: Write `openid-configuration/route.ts`**

```ts
/**
 * OpenID Connect discovery document. One-line handler from the plugin.
 * Published on commcare.app only.
 */

import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = oauthProviderOpenIdConfigMetadata(getAuth());
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
 * Served ONLY on mcp.commcare.app (middleware enforces). Claude Code
 * fetches this URL on its first attempt to call an MCP tool; the response
 * points it at commcare.app as the authorization server, which it then
 * discovers via /.well-known/oauth-authorization-server.
 */

import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { getAuth } from "@/lib/auth";

export const GET = oAuthProtectedResourceMetadata(getAuth());
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
- Create: `lib/auth-client.ts`
- Create: `app/consent/page.tsx`
- Create: `app/consent/ConsentForm.tsx`

- [ ] **Step 1: Write `lib/auth-client.ts`**

```ts
/**
 * Browser-side Better Auth client.
 *
 * Adds the oauth-provider client plugin so the consent page can POST the
 * accept/deny choice through authClient.oauth2.consent({...}) rather than
 * hand-rolling the fetch.
 */

"use client";

import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
	plugins: [oauthProviderClient()],
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

```tsx
/**
 * OAuth consent page (server component).
 *
 * The oauth-provider plugin redirects authenticated users here with a
 * pending authorization request. We resolve the client + scopes
 * server-side and hand them to the client form for the accept/deny
 * decision.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { ConsentForm } from "./ConsentForm";

interface ConsentPageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
	const sp = await searchParams;
	const auth = getAuth();

	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) redirect("/sign-in");

	const pending = await auth.api.oauth2.getPendingAuthorization({
		headers: await headers(),
		query: sp as Record<string, string>,
	});

	const clientName = pending?.client?.client_name ?? "An application";
	const scopes = pending?.scopes ?? [];
	const redirectMismatch = !pending;

	return (
		<main className="mx-auto max-w-xl p-8">
			<ConsentForm
				clientName={clientName}
				scopes={scopes}
				redirectMismatch={redirectMismatch}
			/>
		</main>
	);
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit && echo "✓"`
Expected: `✓`. If Better Auth's `auth.api.oauth2.getPendingAuthorization` signature differs from what this page assumes, adjust per the actual plugin API (context7 for the current signature).

End-to-end consent verification lands in Phase G Task G3 (requires a deployed staging target to run the full OAuth handshake from a real client).

- [ ] **Step 5: Commit**

```bash
git add lib/auth-client.ts app/consent/page.tsx app/consent/ConsentForm.tsx
git commit -m "feat(mcp): OAuth consent page with scope-aware accept/deny"
```
