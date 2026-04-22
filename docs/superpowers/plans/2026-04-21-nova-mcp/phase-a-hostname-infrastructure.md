# Phase A — Hostname infrastructure

**Goal:** Single Cloud Run service, three virtual hostnames. Middleware enforces a per-host path allowlist so the MCP subdomain only serves MCP routes and the docs subdomain only serves docs. Everything off-allowlist 404s. Unknown hostnames (Cloud Run internal health checks, dev localhost) default to main-app behavior.

**Dependencies:** none. This unblocks Phases B and F.

---

## Task A1: Hostname constants + allowlist tables

**Files:**
- Create: `lib/hostnames.ts`
- Create: `lib/__tests__/hostnames.test.ts`

- [ ] **Step 1: Write `lib/hostnames.ts`**

```ts
/**
 * Hostname routing contract.
 *
 * Three hostnames map to the same Cloud Run service; middleware enforces
 * a per-host path allowlist so the MCP subdomain only serves MCP routes
 * and the docs subdomain only serves docs. Everything off-allowlist 404s.
 *
 * Unknown hostnames (e.g. Cloud Run's internal `*-uc.a.run.app` host used
 * by health checks) default to main-app behavior — we don't want to 404
 * platform pings.
 */

export const HOSTNAMES = {
	main: "commcare.app",
	mcp: "mcp.commcare.app",
	docs: "docs.commcare.app",
} as const;

export type Hostname = (typeof HOSTNAMES)[keyof typeof HOSTNAMES];

/**
 * Path prefixes each hostname is allowed to serve. Matching is prefix-based
 * via `startsWith`; `/` exactly matches the root page for hostnames that
 * expose one.
 */
export const HOSTNAME_ALLOWLIST: Record<Hostname, readonly string[]> = {
	[HOSTNAMES.main]: [
		"/",
		"/api/auth",
		"/api/chat",
		"/api/compile",
		"/api/commcare",
		"/api/log",
		"/api/user",
		"/api/admin",
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/admin",
		"/build",
		"/consent",
		"/settings",
		"/sign-in",
		"/_next",
		"/favicon",
	],
	[HOSTNAMES.mcp]: [
		"/mcp",
		"/.well-known/oauth-protected-resource",
	],
	[HOSTNAMES.docs]: [
		"/",
		"/_next",
		"/favicon",
	],
} as const;

/** Normalize the Host header: strip trailing dot, strip explicit :443 / :80. */
export function normalizeHost(raw: string | null): string {
	if (!raw) return "";
	let host = raw.toLowerCase().trim();
	if (host.endsWith(".")) host = host.slice(0, -1);
	host = host.replace(/:(80|443)$/, "");
	return host;
}

/** Classify a normalized host to a known hostname, or `null` if unknown. */
export function classifyHost(host: string): Hostname | null {
	if (host === HOSTNAMES.main) return HOSTNAMES.main;
	if (host === HOSTNAMES.mcp) return HOSTNAMES.mcp;
	if (host === HOSTNAMES.docs) return HOSTNAMES.docs;
	return null;
}

/** True if `path` is allowed on `host`. */
export function isPathAllowedOnHost(host: Hostname, path: string): boolean {
	const allow = HOSTNAME_ALLOWLIST[host];
	for (const prefix of allow) {
		if (prefix === "/" ? path === "/" : path.startsWith(prefix)) return true;
	}
	return false;
}
```

- [ ] **Step 2: Write `lib/__tests__/hostnames.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
	classifyHost,
	HOSTNAMES,
	isPathAllowedOnHost,
	normalizeHost,
} from "../hostnames";

describe("normalizeHost", () => {
	it("lowercases", () => {
		expect(normalizeHost("CommCare.App")).toBe("commcare.app");
	});
	it("strips trailing dot", () => {
		expect(normalizeHost("mcp.commcare.app.")).toBe("mcp.commcare.app");
	});
	it("strips :443 and :80", () => {
		expect(normalizeHost("commcare.app:443")).toBe("commcare.app");
		expect(normalizeHost("commcare.app:80")).toBe("commcare.app");
	});
	it("keeps non-standard ports (dev)", () => {
		expect(normalizeHost("localhost:3000")).toBe("localhost:3000");
	});
	it("returns empty string for null", () => {
		expect(normalizeHost(null)).toBe("");
	});
});

describe("classifyHost", () => {
	it("classifies known hostnames", () => {
		expect(classifyHost("commcare.app")).toBe(HOSTNAMES.main);
		expect(classifyHost("mcp.commcare.app")).toBe(HOSTNAMES.mcp);
		expect(classifyHost("docs.commcare.app")).toBe(HOSTNAMES.docs);
	});
	it("returns null for unknown hostnames", () => {
		expect(classifyHost("foo-uc.a.run.app")).toBeNull();
		expect(classifyHost("localhost:3000")).toBeNull();
	});
});

describe("isPathAllowedOnHost", () => {
	it("allows MCP paths only on mcp.commcare.app", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/mcp")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/mcp")).toBe(false);
	});
	it("blocks /admin on mcp.commcare.app", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/admin")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin")).toBe(true);
	});
	it("allows OAuth-AS metadata on commcare.app but not on mcp", () => {
		expect(
			isPathAllowedOnHost(HOSTNAMES.main, "/.well-known/oauth-authorization-server"),
		).toBe(true);
		expect(
			isPathAllowedOnHost(HOSTNAMES.mcp, "/.well-known/oauth-authorization-server"),
		).toBe(false);
	});
	it("allows resource metadata on mcp but not on main", () => {
		expect(
			isPathAllowedOnHost(HOSTNAMES.mcp, "/.well-known/oauth-protected-resource"),
		).toBe(true);
		expect(
			isPathAllowedOnHost(HOSTNAMES.main, "/.well-known/oauth-protected-resource"),
		).toBe(false);
	});
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/__tests__/hostnames.test.ts`
Expected: all passing.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit && echo "✓"`
Expected: `✓` with no other output.

- [ ] **Step 5: Commit**

```bash
git add lib/hostnames.ts lib/__tests__/hostnames.test.ts
git commit -m "feat(mcp): hostname allowlist utilities"
```

---

## Task A2: Hostname routing in `proxy.ts`

**DO NOT create `middleware.ts`.** Next.js 16 deprecated the `middleware`
file convention in favor of `proxy.ts` (file renamed; exported function is
`proxy(request: NextRequest)`; runtime is Node.js and not configurable).
This repo already ships a `proxy.ts` at the root that owns CSP nonces and
the optimistic auth redirect — two top-level handlers cannot coexist, so
hostname routing must be merged **into** the existing file as the
outermost branch.

**Files:**
- Modify: `proxy.ts` (existing)
- Create: `__tests__/proxy.test.ts`

**Branch order inside `proxy()`** (top to bottom):

1. **Hostname routing.** Normalize `Host` → `normalizeHost(...)`,
   classify → `classifyHost(...)`.
   - `mcp.commcare.app`: `/mcp` rewrites to `/api/mcp` via
     `request.nextUrl.clone()` + `pathname` mutation (so the query
     string survives — `new URL("/api/mcp", request.url)` would discard
     it). Other allowlist entries (only `/.well-known/oauth-protected-resource`)
     pass through with no CSP / auth. Off-allowlist → 404 with
     `Cache-Control: no-store` + `Content-Type: text/plain; charset=utf-8`.
   - `docs.commcare.app`: allowlist passthrough or 404 (same headers).
   - `commcare.app`: off-allowlist 404; on-allowlist falls through to
     steps 2–3.
   - Unknown classification (Cloud Run health probes, dev localhost,
     preview deploys) skips the allowlist gate but still runs steps 2–3.

2. **API short-circuit.** `pathname.startsWith("/api/")` → return
   `NextResponse.next()`. CSP and auth-redirect must not run on JSON
   endpoints; they would silently break every API client. This branch
   exists because the matcher widened to include `/api` (so the MCP
   host could intercept `/api/mcp`), and without this short-circuit
   the main host's API routes would now wrongly receive page-style
   treatment.

3. **Pages: nonce-based CSP + optimistic auth.** Existing logic.
   `/.well-known/*` is exempt from the auth redirect — OAuth/OIDC
   discovery endpoints must be reachable unauthenticated, otherwise
   OAuth clients cannot bootstrap.

**Matcher.** Widens from `"/((?!api|_next/static|_next/image|favicon.ico).*)"`
to `"/((?!_next/static|_next/image|favicon.ico).*)"` so MCP-host
`/api/mcp` rewrites can be intercepted. The API short-circuit (step 2)
keeps the widened matcher from breaking main-host API behavior.

**404 helper.** A module-local `function notFound(): NextResponse`
centralizes the `no-store` + `text/plain` 404 response so all three host
branches return the identical response.

**Return type.** `proxy(request: NextRequest): NextResponse` is annotated
explicitly.

**Tests** (`__tests__/proxy.test.ts`) use a `req(host, path)` helper that
puts the host in the wire `Host` header (the placeholder URL origin is
irrelevant — the proxy reads `request.headers.get("host")`). Helpers
`expectPassthrough`, `expectRewrite`, `expectNotFound`,
`expectAuthRedirect` give affirmative assertions (404s are checked for
`no-store`; rewrites are checked for `x-middleware-rewrite` containing
the internal target). Coverage:

- mcp host: `/mcp` rewrites to `/api/mcp`; `/mcp?session=abc&foo=bar`
  preserves the query string; `/api/mcp` directly 404s; OAuth-protected-resource
  passes through; `/admin` 404s; OAuth-AS metadata 404s; trailing-dot
  host normalizes; explicit `:443` port normalizes.
- docs host: `/` passes; `/_next/data/foo.json` passes (matcher
  excludes `/_next/static` and `/_next/image` only — other `/_next`
  paths still hit the proxy and need allowlist coverage); `/api/chat`
  404s.
- main host: OAuth-AS metadata passes through (auth-redirect skips
  `/.well-known/*`); `/api/mcp` 404s (MCP belongs to its subdomain);
  unauthenticated `/admin` returns 307 to `/`; `/api/chat` passes through
  with no CSP header set (API short-circuit verified).
- unknown host: `/api/chat` passes through with no auth redirect (Cloud
  Run health probes must not be redirected).

- [ ] **Step 1: Read context7 to confirm the convention**

Use `mcp__context7__resolve-library-id` then `mcp__context7__query-docs`
on `/vercel/next.js` for `"Next.js 16 proxy middleware rename matcher
rewrite NextResponse"`. Confirm: `proxy.ts`, `proxy(request)`, Node.js
runtime, `config = { matcher: [...] }`, `NextResponse.rewrite(URL)`.

- [ ] **Step 2: Modify `proxy.ts`** to integrate the hostname branch
above the existing CSP/auth logic, add the API short-circuit, exempt
`/.well-known/*` from the auth redirect, widen the matcher, and add
the `notFound()` helper. The previous commit's `proxy.ts` is the
canonical reference — re-running this task should produce a functionally
identical file.

- [ ] **Step 3: Create `__tests__/proxy.test.ts`** with the coverage
matrix above.

- [ ] **Step 4: Run + type-check**

Run: `npx vitest run __tests__/proxy.test.ts && npx tsc --noEmit && echo "✓"`
Expected: 16 tests passing + `✓`.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts __tests__/proxy.test.ts
git commit -m "refactor(mcp): integrate hostname routing into proxy.ts"
```

---

## Task A3: Cloud Run domain mapping (infrastructure doc)

**Files:**
- Create: `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`

- [ ] **Step 1: Write the infra note**

```markdown
# Nova MCP — infra changes

## Cloud Run domain mappings

Before the MCP endpoint can be exercised end-to-end, two new domain mappings
must be configured on the existing Cloud Run service:

    mcp.commcare.app  → nova service (region: us-central1)
    docs.commcare.app → nova service (region: us-central1)

These are domain mappings on the same service, not separate services —
middleware.ts splits them. Set via the GCP console (Cloud Run → domain
mappings) or gcloud:

    gcloud beta run domain-mappings create \
      --service nova \
      --domain mcp.commcare.app \
      --region us-central1

    gcloud beta run domain-mappings create \
      --service nova \
      --domain docs.commcare.app \
      --region us-central1

DNS: add CNAMEs on commcare.app pointing both subdomains at
`ghs.googlehosted.com.` (GCP's managed cert host). Cert provisioning takes
a few minutes. Verify with:

    curl -I https://mcp.commcare.app/mcp
    curl -I https://docs.commcare.app/

Both should return a valid TLS handshake and a Cloud Run response.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): document Cloud Run domain mapping requirements"
```
