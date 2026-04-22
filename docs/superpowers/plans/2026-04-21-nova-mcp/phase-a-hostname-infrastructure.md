# Phase A — Hostname infrastructure

**Status:** ✅ Complete (2026-04-21).

**Goal:** Single Cloud Run service, three virtual hostnames. `proxy.ts` enforces a per-host path allowlist so the MCP subdomain only serves MCP routes and the docs subdomain only serves docs. Everything off-allowlist 404s with `Cache-Control: no-store`. Unknown hostnames (Cloud Run internal health checks, dev localhost, preview deploys) skip the allowlist gate but still flow through API short-circuit + page handling.

**Dependencies:** none. This unblocks Phases B and F.

**Shipped artifacts:** `lib/hostnames.ts`, `lib/__tests__/hostnames.test.ts` (15 tests), `proxy.ts` (modified — hostname routing integrated as outermost branch above the existing CSP+auth logic), `__tests__/proxy.test.ts` (23 tests), `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`.

---

## Task A1: Hostname constants + allowlist tables ✅

**Files:**
- Create: `lib/hostnames.ts`
- Create: `lib/__tests__/hostnames.test.ts`

The module owns the routing contract for `proxy.ts`. Three things must hold:

1. **`HOSTNAMES` is the single source of truth** — adding a new hostname extends the `Hostname` type, requires a new `HOSTNAME_ALLOWLIST` entry (TypeScript-enforced via `satisfies`), and automatically extends the set used by `classifyHost` (so a forgotten `if`-branch can't silently drop the new host on the floor).
2. **`HOSTNAME_ALLOWLIST` is segment-anchored** — an entry `/foo` grants `/foo` exactly and any `/foo/...` subpath, but never `/foobar`. This is a security boundary: substring matching would silently leak any future route that happens to share a prefix (`/admins` would match `/admin`).
3. **`normalizeHost` strips `:80`/`:443`** — Cloud Run forwards the wire `Host` header faithfully; standard ports may or may not be explicit. Preserve dev ports (`localhost:3000`).

- [x] **Step 1: Write `lib/hostnames.ts`**

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
 * Path prefixes each hostname is allowed to serve. Matching is segment-anchored:
 * an entry `/foo` grants `/foo` exactly and any `/foo/...` subpath, but never
 * `/foobar`. The exception is `/`, which matches only the root page so it
 * doesn't act as a wildcard for an entire host.
 *
 * This is a security boundary — every entry widens the externally reachable
 * surface area on its host. Add with care.
 *
 * Declared with `satisfies` so each host's prefix tuple keeps its literal-string
 * element types — the `Record<Hostname, readonly string[]>` constraint is
 * enforced without widening the value type.
 */
export const HOSTNAME_ALLOWLIST = {
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
	[HOSTNAMES.mcp]: ["/mcp", "/.well-known/oauth-protected-resource"],
	[HOSTNAMES.docs]: ["/", "/_next", "/favicon"],
} as const satisfies Record<Hostname, readonly string[]>;

/** Normalize the Host header: lowercase, strip trailing dot, strip :80 / :443. */
export function normalizeHost(raw: string | null): string {
	if (!raw) return "";
	let host = raw.toLowerCase().trim();
	if (host.endsWith(".")) host = host.slice(0, -1);
	host = host.replace(/:(80|443)$/, "");
	return host;
}

/**
 * All hostnames this service knows about, built from `HOSTNAMES` so the set
 * cannot drift from the typed source of truth. Declared as `Set<string>` —
 * `Set.prototype.has` requires its argument to match the element type, so a
 * narrow `Set<Hostname>` would refuse arbitrary string input from the wire.
 * The narrowing happens one level up, inside `isKnownHostname`.
 */
const KNOWN_HOSTNAMES: ReadonlySet<string> = new Set(Object.values(HOSTNAMES));

/** Type predicate: true iff `host` is one of the known hostnames. */
function isKnownHostname(host: string): host is Hostname {
	return KNOWN_HOSTNAMES.has(host);
}

/** Classify a normalized host to a known hostname, or `null` if unknown. */
export function classifyHost(host: string): Hostname | null {
	return isKnownHostname(host) ? host : null;
}

/**
 * True if `path` is allowed on `host`. Matching is anchored at path-segment
 * boundaries — `/admin` allows `/admin` and `/admin/users` but NOT `/admins`,
 * because the allowlist is a security boundary and substring matches would
 * leak future routes that happen to share a prefix.
 */
export function isPathAllowedOnHost(host: Hostname, path: string): boolean {
	return HOSTNAME_ALLOWLIST[host].some((prefix) =>
		prefix === "/"
			? path === "/"
			: path === prefix || path.startsWith(`${prefix}/`),
	);
}
```

- [x] **Step 2: Write `lib/__tests__/hostnames.test.ts`**

15 tests. Coverage matrix:

- `normalizeHost`: lowercases; trims whitespace; strips trailing dot; strips `:443` and `:80`; preserves non-standard ports (e.g. `localhost:3000`); returns `""` for null.
- `classifyHost`: classifies all three known hostnames; returns `null` for unknown (`foo-uc.a.run.app`, `localhost:3000`); returns `null` for empty string (covers the `normalizeHost(null) → "" → classifyHost("")` path).
- `isPathAllowedOnHost`:
  - `/mcp` allowed on mcp / blocked on main; `/admin` blocked on mcp / allowed on main.
  - OAuth-AS metadata allowed on main / blocked on mcp.
  - OAuth-protected-resource metadata allowed on mcp / blocked on main.
  - Segment-boundary negatives: `/admins`, `/api/authority`, `/buildings` all denied on main (proves substring matching is rejected).
  - Exact prefix and deeper subpath positives: `/admin`, `/admin/users`, `/api/auth/callback` all allowed on main.

- [x] **Step 3: Run tests** — `npx vitest run lib/__tests__/hostnames.test.ts` → 15/15 passing.

- [x] **Step 4: Type-check** — `npx tsc --noEmit && echo "✓"` → `✓`.

- [x] **Step 5: Commit** — `feat(mcp): hostname allowlist utilities` (cd045d1), with three follow-up refactors (`b8d2c04`, `e1e96ab`, `9d297a5`) tightening matching semantics, single-source-of-truth typing, and the `isKnownHostname` predicate.

---

## Task A2: Hostname routing in `proxy.ts` ✅

> **DO NOT create `middleware.ts`.** Next.js 16 deprecated the `middleware`
> file convention in favor of `proxy.ts` (file renamed; exported function
> is `proxy(request: NextRequest)`; runtime is Node.js and not configurable).
> This repo already ships a `proxy.ts` at the root that owns CSP nonces and
> the optimistic auth redirect — two top-level handlers cannot coexist, so
> hostname routing must be merged **into** the existing file as the
> outermost branch.

**Files:**
- Modify: `proxy.ts` (existing)
- Create: `__tests__/proxy.test.ts`

### Branch order inside `proxy()`

```
1. Hostname routing
   - mcp host → exact-match /mcp (and /mcp/) rewrite to /api/mcp;
                exact-match other allowlist entries (currently just
                OAuth-protected-resource) passthrough; else 404.
   - docs host → allowlist passthrough (segment-anchored) or 404.
   - main host → off-allowlist 404; on-allowlist falls through.
   - unknown   → fall through (Cloud Run health checks, dev localhost,
                 preview deploys, empty/missing Host header).
2. API + well-known short-circuit
   - /api, /api/*, /.well-known/* → NextResponse.next() with no CSP
     and no auth. JSON endpoints and discovery metadata must not get
     page-shaped CSP nonces or HTML auth redirects.
3. Pages: nonce-based CSP + optimistic auth (existing logic, preserved).
```

### Critical implementation details

1. **The MCP host inlines its routing — does NOT call `isPathAllowedOnHost`.** The mcp-host surface is exactly two routes (`/mcp`, `/.well-known/oauth-protected-resource`). Reusing the segment-anchored matcher would let `/mcp/foo` pass the prefix check and fall through to a non-existent page, missing the security-boundary 404 contract. The inline branch reads the canonical list from `HOSTNAME_ALLOWLIST[HOSTNAMES.mcp]` (so adding a route is still a one-line change in `lib/hostnames.ts`) but exact-matches each entry instead of prefix-matching.

2. **`/mcp` and `/mcp/` (trailing slash) both rewrite to the same internal target `/api/mcp`** — the route handler lives at `app/api/mcp/route.ts`, so the canonical internal path is dash-free. The rewrite uses `request.nextUrl.clone()` + `target.pathname = "/api/mcp"`, NOT `new URL("/api/mcp", request.url)` — the latter discards the query string, breaking OAuth flows that pass `?session=…` / `?code=…`.

3. **CSP must be set on BOTH the request and the response.** The official Next.js docs are explicit: Next.js parses the inbound `Content-Security-Policy` header during SSR and automatically stamps `nonce="..."` onto every framework-generated `<script>` tag (the `_next/static/*` bundles). Without the request-side set, `'strict-dynamic'` blocks every framework script and the app renders blank in production. The response-side set is what the browser enforces. Both lines are load-bearing — neither is dead code. Regression test asserts `x-middleware-override-headers` carries both `content-security-policy` and `x-nonce`.

4. **CSP nonce uses raw random bytes**, not `Buffer.from(crypto.randomUUID())`. The latter base64-encodes the ASCII representation of the UUID — structurally fixed dashes and version nibbles waste the entropy that `'strict-dynamic'` relies on to prevent attackers guessing valid nonces.

   ```ts
   const nonceBytes = new Uint8Array(16);
   crypto.getRandomValues(nonceBytes);
   const nonce = Buffer.from(nonceBytes).toString("base64");
   ```

5. **`/.well-known/*` rides the same short-circuit as `/api/*`** — discovery metadata is JSON, not a page; the page CSP nonce assembly and the unauthenticated-redirect would both be wrong for it. (OAuth clients must be able to bootstrap unauthenticated.)

6. **`/api` exact-match short-circuits in addition to `/api/*`** — `pathname.startsWith("/api/")` alone misses the bare `/api` path (no trailing slash).

7. **Off-allowlist 404s use a shared `notFound()` helper** that sets `Cache-Control: no-store` and `Content-Type: text/plain; charset=utf-8`. The security boundary cannot be cached by an intermediary — a cached 404 against a route that gets added later would silently keep returning 404.

8. **Matcher widens** from `"/((?!api|_next/static|_next/image|favicon.ico).*)"` to `"/((?!_next/static|_next/image|favicon.ico).*)"`. `/api` is included so the MCP host can intercept `/api/mcp`; the API short-circuit (step 2) prevents the widened matcher from breaking main-host API behavior.

9. **`proxy()` carries an explicit `: NextResponse` return type.**

### Test coverage (`__tests__/proxy.test.ts` — 23 tests)

Helpers:
- `req(host, path)` — wire `Host` header set; placeholder URL origin (`http://example.test`) since the proxy reads `request.headers.get("host")`.
- `reqWithSession(host, path)` — adds `cookie: better-auth.session_token=…` so the auth-redirect branch can be exercised. Better-Auth runtime default; a Better Auth upgrade may require updating the literal.
- `expectPassthrough(res)` — status not 404, no rewrite header.
- `expectBypassPassthrough(res)` — passthrough AND no `Content-Security-Policy`/`x-nonce` headers (used everywhere CSP must NOT attach).
- `expectRewrite(res, target)` — status not 404, `x-middleware-rewrite` contains target.
- `expectNotFound(res)` — status 404 AND `Cache-Control: no-store`.
- `expectAuthRedirect(res)` — status 307 AND `Location` resolves to `/`.

Cases:
- **mcp host:** `/mcp` rewrites to `/api/mcp`; `/mcp/` (trailing slash) rewrites identically; `/mcp?session=abc&foo=bar` preserves query string; `/mcp/?session=abc` preserves query string; `/mcp/foo` 404s (proves the segment-leak hole is closed); `/api/mcp` directly 404s (internal path not externally reachable); `/.well-known/oauth-protected-resource` is bypass-passthrough; `/admin` 404s; `/.well-known/oauth-authorization-server` 404s (belongs to main); trailing-dot host `mcp.commcare.app.` classifies as mcp; `mcp.commcare.app:443` classifies as mcp.
- **docs host:** `/` is bypass-passthrough; `/api/chat` 404s (not on docs allowlist).
- **main host:** `/.well-known/oauth-authorization-server` is bypass-passthrough (short-circuit); `/api/chat` is bypass-passthrough (short-circuit); `/api/auth/sign-in` is bypass-passthrough (short-circuit); `/api/mcp` 404s (MCP belongs to its subdomain — not on main allowlist); unauthenticated `/admin` returns 307 to `/`; authenticated `/build` (with session cookie) returns CSP-attached response with `script-src 'nonce-…'`.
- **CSP forwarding regression test:** authenticated `/build` response carries `x-middleware-override-headers` containing both `content-security-policy` and `x-nonce`, AND the per-header values `x-middleware-request-content-security-policy` and `x-middleware-request-x-nonce` are set. Pins Next.js auto-nonce wiring.
- **unknown host:** `/api/chat` is bypass-passthrough on `nova-abc-uc.a.run.app` (Cloud Run health probes must not be auth-redirected); empty `Host` header on `/build` flows through to page handling without 404.

### Steps

- [x] **Step 1: Confirm convention via context7** — `mcp__context7__resolve-library-id` then `mcp__context7__query-docs` on `/vercel/next.js` for `"Next.js 16 proxy middleware rename matcher rewrite NextResponse"`. Confirmed: `proxy.ts`, `proxy(request)`, Node.js runtime, `config = { matcher: [...] }`, `NextResponse.rewrite(URL)`, `nextUrl.clone()` + pathname mutation as the documented way to preserve query strings on rewrite, and Next.js auto-nonce on framework scripts requires the inbound CSP request header.

- [x] **Step 2: Modify `proxy.ts`** to integrate the hostname branch above the existing CSP/auth logic, add the API + well-known short-circuit, widen the matcher, add the `notFound()` helper, switch the nonce to raw random bytes, and forward CSP on both request and response. The current `proxy.ts` at HEAD is the canonical reference — re-running this task should produce a functionally identical file.

- [x] **Step 3: Create `__tests__/proxy.test.ts`** with the 23-test coverage matrix above.

- [x] **Step 4: Run + type-check** — `npx vitest run __tests__/proxy.test.ts && npx tsc --noEmit && echo "✓"` → 23/23 passing + `✓`.

- [x] **Step 5: Commits** — initial integration `83be36f`, three follow-up refactors (`f9c121b`, `8134545`, `857c473`) tightening the MCP-host inline routing, well-known short-circuit, nonce entropy, and the request-side CSP forwarding regression test.

---

## Task A3: Cloud Run domain mapping (infrastructure doc) ✅

**Files:**
- Create: `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`

- [x] **Step 1: Write the infra note**

```markdown
# Nova MCP — infra changes

## Cloud Run domain mappings

Before the MCP endpoint can be exercised end-to-end, two new domain mappings
must be configured on the existing Cloud Run service:

    mcp.commcare.app  → nova service (region: us-central1)
    docs.commcare.app → nova service (region: us-central1)

These are domain mappings on the same service, not separate services —
proxy.ts splits them. Set via the GCP console (Cloud Run → domain
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

- [x] **Step 2: Commit** — `docs(mcp): document Cloud Run domain mapping requirements` (552b9b1).

---

## Lessons captured during execution

These shaped the plan above and are worth carrying forward when reviewing later phases:

1. **Check the framework docs before deleting "dead" code.** Two reviews in this phase claimed code was unused that turned out to be load-bearing: the `middleware.ts` file convention (renamed to `proxy.ts` in Next 16) and the request-side `Content-Security-Policy` header (mechanism for Next.js auto-nonce on framework scripts). Verify against the framework's own docs before applying a deletion.
2. **`startsWith` is not safe for path allowlists.** Always anchor at path-segment boundaries (`path === prefix || path.startsWith(prefix + "/")`). Substring matches silently leak future routes whose paths share a prefix with an allowlist entry.
3. **Off-allowlist 404s on a security boundary need `Cache-Control: no-store`.** A cached 404 against a route that's added later would keep returning 404 from intermediaries even after the allowlist changes.
4. **Single source of truth for hostname identity.** Derive `classifyHost`'s membership set from `HOSTNAMES` (don't open-code if-branches), and constrain `HOSTNAME_ALLOWLIST` with `satisfies` so each host's prefix tuple keeps its literal-string element types.
5. **CSP nonce entropy matters.** Use raw `crypto.getRandomValues(new Uint8Array(16))`, not `Buffer.from(crypto.randomUUID()).toString("base64")` — the latter wastes the entropy that `'strict-dynamic'` depends on.
