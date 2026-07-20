import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AS_ISSUER,
	classifyHost,
	HOSTNAMES,
	isPathAllowedOnHost,
	MCP_RESOURCE_URL,
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
	it("trims whitespace", () => {
		expect(normalizeHost("  commcare.app  ")).toBe("commcare.app");
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
	it("returns null for empty string (missing Host header)", () => {
		expect(classifyHost("")).toBeNull();
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
	it("does not list /docs on the docs allowlist (it's an internal path)", () => {
		/* `/docs` is the internal Next route; the docs site lives at the
		 * root externally. The proxy rewrites bare paths to `/docs/<...>`
		 * itself rather than admitting `/docs` as a public surface. */
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/docs")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/docs/claude-code")).toBe(
			false,
		);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/docs")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/docs")).toBe(false);
	});
	it("keeps /mcp on the MCP host only", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/mcp")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/mcp")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/mcp")).toBe(false);
	});
	it("allows /api/media only on the main host", () => {
		/* The media routes (library, upload, asset read/delete, extract)
		 * are builder-app surfaces, so they live on the main host only —
		 * never the MCP or docs subdomains. Regression guard: these routes
		 * shipped in #45 without an allowlist entry and 404'd in prod for
		 * every request until #58 made them a user-facing flow. */
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/media")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/media/library")).toBe(
			true,
		);
		expect(
			isPathAllowedOnHost(HOSTNAMES.main, "/api/media/abc-123/extract"),
		).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/api/media")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/api/media")).toBe(false);
	});
	it("allows docs search only on the docs host", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/api/search")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/search")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/api/search")).toBe(false);
	});
	it("allows OAuth-AS metadata on commcare.app but not on mcp", () => {
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.main,
				"/.well-known/oauth-authorization-server",
			),
		).toBe(true);
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.mcp,
				"/.well-known/oauth-authorization-server",
			),
		).toBe(false);
	});
	it("allows resource metadata on mcp but not on main", () => {
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.mcp,
				"/.well-known/oauth-protected-resource",
			),
		).toBe(true);
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.main,
				"/.well-known/oauth-protected-resource",
			),
		).toBe(false);
	});
	it("does not match across path-segment boundary", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admins")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/authority")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/buildings")).toBe(false);
	});
	it("matches exact prefix and deeper subpaths", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin/users")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/auth/callback")).toBe(
			true,
		);
	});
	it("keeps /api/dev/login off every host allowlist", () => {
		/* The local-dev login backdoor (`app/api/dev/login/route.ts`) must stay
		 * OFF the allowlists so the proxy 404s it on every production host
		 * before the route module even loads — the outer layer of its
		 * defense-in-depth (the inner is the handler's own NODE_ENV gate).
		 * Whoever "fixes" a prod 404 on this path by adding an allowlist
		 * entry is disabling that layer — don't. */
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/dev/login")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/api/dev/login")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.docs, "/api/dev/login")).toBe(false);
	});
});

/**
 * Structural guard for the deploy-time footgun this file's `/api/media` case
 * already documents: a new page route under the main-host `app/(app)/` tree
 * that nobody adds to `HOSTNAME_ALLOWLIST` renders fine on localhost (the
 * unknown-host branch in `proxy.ts` skips the allowlist) and 404s in prod (the
 * main host gates every path). `/project` and `/accept-invitation` both shipped
 * this way with the shared-Project work. Rather than trust everyone to remember
 * the allowlist, we walk the router tree and assert every main-host page path is
 * reachable — a missing entry fails CI instead of prod.
 */
const APP_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"app",
);

/** Route-group segment like `(app)` — organizes files without a URL segment. */
function isRouteGroup(segment: string): boolean {
	return segment.startsWith("(") && segment.endsWith(")");
}

/** Dynamic segment like `[id]`, `[...path]`, `[[...slug]]` — matches any value. */
function isDynamicSegment(segment: string): boolean {
	return segment.startsWith("[");
}

/** Recursively collect every `page.tsx` path relative to `app/`. */
function collectPageRoutes(dir: string, prefix: string[] = []): string[][] {
	const routes: string[][] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			routes.push(
				...collectPageRoutes(join(dir, entry.name), [...prefix, entry.name]),
			);
		} else if (entry.name === "page.tsx") {
			routes.push(prefix);
		}
	}
	return routes;
}

/** Turn a page's directory segments into the wire path the proxy sees, with
 *  dynamic segments filled by a concrete placeholder so prefix matching works. */
function toWirePath(segments: string[]): string {
	const parts = segments
		.filter((s) => !isRouteGroup(s))
		.map((s) => (isDynamicSegment(s) ? "x" : s));
	return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

describe("main-host page routes are all allowlisted (regression guard)", () => {
	/* The main app lives under `app/(app)/`; `(docs)` is the docs host and
	 * `(dev-only)` is intentionally unreachable in prod, so neither belongs on
	 * the main-host allowlist. */
	const mainHostPages = collectPageRoutes(APP_DIR)
		.filter((segments) => segments[0] === "(app)")
		.map(toWirePath)
		/* `/warmup` is the Cloud Run startup probe on the internal `*.run.app`
		 * host; `proxy.ts` documents that the main host deliberately 404s it. */
		.filter((path) => path !== "/warmup");

	it("discovers the known main-host pages (walker sanity check)", () => {
		expect(mainHostPages).toContain("/project");
		expect(mainHostPages).toContain("/accept-invitation");
		expect(mainHostPages).toContain("/settings");
	});

	it.each(mainHostPages)("allows %s on the main host", (path) => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, path)).toBe(true);
	});
});

describe("OAuth resource identifiers", () => {
	it("uses the externally reachable MCP endpoint URL as the protected resource", () => {
		expect(MCP_RESOURCE_URL).toBe("https://mcp.commcare.app/mcp");
	});

	it("uses Better Auth's /api/auth base path as the token issuer", () => {
		expect(AS_ISSUER).toBe("https://commcare.app/api/auth");
	});
});
