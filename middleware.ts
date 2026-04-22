/**
 * Hostname-aware edge middleware.
 *
 * Splits a single Cloud Run service into three virtual hosts:
 *   - commcare.app     → web app + /api/auth + OAuth-AS metadata
 *   - mcp.commcare.app → /mcp (rewritten to /api/mcp) + OAuth-protected-resource metadata
 *   - docs.commcare.app → documentation only
 *
 * The `/mcp` → `/api/mcp` rewrite lets the external URL stay clean
 * (`https://mcp.commcare.app/mcp`) while the Next.js route file lives at
 * the convention path `app/api/mcp/route.ts` and `mcp-handler`'s
 * `basePath: "/api"` default stays unchanged.
 *
 * Unknown hostnames (Cloud Run's generated *.run.app host used by health
 * checks, or the user's localhost in dev) default to main-app behavior so
 * platform-level requests don't get 404s.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	classifyHost,
	HOSTNAMES,
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

	/* External /mcp on the MCP host rewrites to the internal route path
	 * /api/mcp. Allowlist still gates on the external path name. */
	if (classified === HOSTNAMES.mcp && path === "/mcp") {
		return NextResponse.rewrite(new URL("/api/mcp", req.url));
	}

	if (isPathAllowedOnHost(classified, path)) return NextResponse.next();

	return new NextResponse("Not Found", { status: 404 });
}
