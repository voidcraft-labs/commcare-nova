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
		"/api/mcp",
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
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/api/mcp")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/mcp")).toBe(false);
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

## Task A2: Middleware

**Files:**
- Create: `middleware.ts`
- Create: `__tests__/middleware.test.ts`

- [ ] **Step 1: Write `middleware.ts`**

```ts
/**
 * Hostname-aware edge middleware.
 *
 * Splits a single Cloud Run service into three virtual hosts:
 *   - commcare.app     → web app + /api/auth + OAuth-AS metadata
 *   - mcp.commcare.app → /api/mcp + OAuth-protected-resource metadata
 *   - docs.commcare.app → documentation only
 *
 * Unknown hostnames (Cloud Run's generated *.run.app host used by health
 * checks, or the user's localhost in dev) default to main-app behavior so
 * platform-level requests don't get 404s.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
	classifyHost,
	isPathAllowedOnHost,
	normalizeHost,
} from "@/lib/hostnames";

export const config = {
	matcher: [
		/* Match all request paths except static-file-esque ones the edge
		 * runtime shouldn't touch. _next/static and _next/image are
		 * Next-internal; favicon + robots are root assets. */
		"/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt).*)",
	],
};

export function middleware(req: NextRequest) {
	const host = normalizeHost(req.headers.get("host"));
	const classified = classifyHost(host);

	/* Unknown host → treat as main app (Cloud Run health checks, dev
	 * localhost, preview deploys). We only gate the paths of the two
	 * explicit subdomains. */
	if (!classified) return NextResponse.next();

	const path = req.nextUrl.pathname;
	if (isPathAllowedOnHost(classified, path)) return NextResponse.next();

	return new NextResponse("Not Found", { status: 404 });
}
```

- [ ] **Step 2: Write `__tests__/middleware.test.ts`**

```ts
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../middleware";

function req(host: string, path: string): NextRequest {
	const url = new URL(`https://${host}${path}`);
	return new NextRequest(url, { headers: { host } });
}

describe("middleware hostname routing", () => {
	it("passes /api/mcp on mcp.commcare.app", () => {
		const res = middleware(req("mcp.commcare.app", "/api/mcp"));
		expect(res.status).not.toBe(404);
	});
	it("404s /admin on mcp.commcare.app", () => {
		const res = middleware(req("mcp.commcare.app", "/admin"));
		expect(res.status).toBe(404);
	});
	it("404s /api/mcp on commcare.app", () => {
		const res = middleware(req("commcare.app", "/api/mcp"));
		expect(res.status).toBe(404);
	});
	it("allows OAuth-AS metadata on commcare.app", () => {
		const res = middleware(
			req("commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expect(res.status).not.toBe(404);
	});
	it("404s OAuth-AS metadata on mcp.commcare.app", () => {
		const res = middleware(
			req("mcp.commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expect(res.status).toBe(404);
	});
	it("handles trailing-dot host", () => {
		const res = middleware(req("mcp.commcare.app.", "/api/mcp"));
		expect(res.status).not.toBe(404);
	});
	it("passes unknown Cloud Run host through as main app", () => {
		const res = middleware(req("nova-abc-uc.a.run.app", "/api/chat"));
		expect(res.status).not.toBe(404);
	});
});
```

- [ ] **Step 3: Run + type-check**

Run: `npx vitest run __tests__/middleware.test.ts && npx tsc --noEmit && echo "✓"`
Expected: all tests passing + `✓`.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts __tests__/middleware.test.ts
git commit -m "feat(mcp): hostname-aware middleware with per-host allowlists"
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

    curl -I https://mcp.commcare.app/api/mcp
    curl -I https://docs.commcare.app/

Both should return a valid TLS handshake and a Cloud Run response.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): document Cloud Run domain mapping requirements"
```
