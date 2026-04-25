/**
 * Better Auth catch-all route handler.
 *
 * Handles all /api/auth/* requests — OAuth flows, session management,
 * sign-in/sign-out. Better Auth routes internally based on the path segment.
 *
 * Uses `auth.handler` directly instead of `toNextJsHandler` so the auth
 * singleton is initialized on first request via `getAuth()`, not at module
 * import time (which would crash during `next build`).
 */
import { getAuth } from "@/lib/auth";
import {
	cleanupStalePublicOAuthClients,
	recordOAuthGrantRevocationForToken,
} from "@/lib/db/oauth-consents";
import { log } from "@/lib/logger";

async function readRevokedToken(req: Request): Promise<string | null> {
	const contentType = req.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const body = (await req.json().catch(() => null)) as {
			token?: unknown;
		} | null;
		return typeof body?.token === "string" && body.token ? body.token : null;
	}

	const raw = await req.text().catch(() => "");
	const token = new URLSearchParams(raw).get("token");
	return token || null;
}

const handler = async (req: Request) => {
	const url = new URL(req.url);
	const isOAuthRevoke =
		req.method === "POST" && url.pathname.endsWith("/oauth2/revoke");
	const isOAuthRegister =
		req.method === "POST" && url.pathname.endsWith("/oauth2/register");

	const authReq = isOAuthRevoke ? req.clone() : req;
	const revokedToken = isOAuthRevoke ? await readRevokedToken(req) : null;
	const response = await getAuth().handler(authReq);

	if (isOAuthRegister && response.ok) {
		try {
			await cleanupStalePublicOAuthClients();
		} catch (err) {
			log.error("[auth/oauth] stale public-client cleanup failed", err);
		}
	}

	if (isOAuthRevoke && response.ok && revokedToken) {
		try {
			await recordOAuthGrantRevocationForToken(revokedToken);
		} catch (err) {
			log.error("[auth/oauth] grant revocation watermark failed", err);
			return new Response(null, { status: 500 });
		}
	}

	return response;
};

export { handler as GET, handler as POST };
