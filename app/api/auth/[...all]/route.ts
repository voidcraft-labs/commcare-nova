/**
 * Better Auth catch-all route handler.
 *
 * Handles all /api/auth/* requests: OAuth flows, session management,
 * sign-in/sign-out. Better Auth routes internally based on the path segment.
 *
 * Uses `auth.handler` directly instead of `toNextJsHandler` so the auth
 * singleton is initialized on first request via `getAuth()`, not at module
 * import time (which would crash during `next build`).
 */
import { declaredBodyTooLarge, OAUTH_REVOKE_MAX_BYTES } from "@/lib/apiError";
import { getAuth } from "@/lib/auth";
import { recordOAuthGrantRevocationForToken } from "@/lib/db/oauth-consents";
import { log } from "@/lib/logger";
import {
	classifyAuthorizeResponse,
	connectionIssueUrl,
} from "@/lib/oauth/authorize-errors";

async function readRevokedToken(req: Request): Promise<string | null> {
	// A revoke body is a single token. Bound this app-owned read so a public
	// caller can't make the wrapper buffer a large body ahead of Better Auth's
	// own handling; an over-cap body just skips the watermark bookkeeping (the
	// cloned request still reaches the provider, which applies its own limits).
	if (declaredBodyTooLarge(req, OAUTH_REVOKE_MAX_BYTES)) return null;
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

/**
 * True when a person's browser is navigating to this URL, as opposed to a
 * script calling it. Better Auth answers a fetch caller with a JSON
 * `{ redirect, url }` form of the same outcome, and that caller reads it, so
 * those responses are never rewritten.
 */
function isBrowserNavigation(req: Request): boolean {
	if ((req.headers.get("accept") ?? "").includes("application/json")) {
		return false;
	}
	const fetchMode = req.headers.get("sec-fetch-mode");
	return fetchMode === null || fetchMode.toLowerCase() === "navigate";
}

/** The parsed JSON body of a non-redirect 4xx, read from a clone so the
 * original response stays returnable. Anything unreadable is no body. */
async function readErrorBody(response: Response): Promise<unknown> {
	if (response.status < 400 || response.status >= 500) return undefined;
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return undefined;
	return response
		.clone()
		.json()
		.catch(() => undefined);
}

const handler = async (req: Request) => {
	const url = new URL(req.url);
	const isOAuthRevoke =
		req.method === "POST" && url.pathname.endsWith("/oauth2/revoke");
	const isOAuthAuthorize = url.pathname.endsWith("/oauth2/authorize");

	const authReq = isOAuthRevoke ? req.clone() : req;
	const revokedToken = isOAuthRevoke ? await readRevokedToken(req) : null;

	let response: Response;
	try {
		const auth = await getAuth();
		response = await auth.handler(authReq);
	} catch (err) {
		/* Better Auth catches its OWN failures and routes them through the
		 * logger bridge (`lib/auth-logger.ts`) into Sentry. An error thrown
		 * OUTSIDE that try/catch: a transport-level fault like the Google-auth
		 * token fetch's `ERR_STREAM_PREMATURE_CLOSE` surfacing through the
		 * per-request rate-limiter's database call: escapes to here, where
		 * Next would otherwise return an empty 500 that never reaches Sentry.
		 * That was the blind spot behind the prod-login outage: the whole
		 * `/api/auth/*` surface 500'd with nothing logged anywhere. Mirror it to
		 * Sentry via `log.error`, then return the same opaque 500 to the client. */
		log.error("[auth] handler threw before Better Auth could handle it", err, {
			path: url.pathname,
			method: req.method,
		});
		return new Response(null, { status: 500 });
	}

	if (isOAuthRevoke && response.ok && revokedToken) {
		try {
			const wrote = await recordOAuthGrantRevocationForToken(revokedToken);
			if (!wrote) {
				/* Better Auth's `/oauth2/revoke` returns 200 even for invalid
				 * tokens (RFC 7009 §2.2), so a `false` here means we couldn't
				 * classify the token as either a verifiable JWT or a refresh
				 * token in our table. With JWT signature verification in
				 * place, that's operationally interesting: a spike of these
				 * is the visible signal that token shape and watermark logic
				 * have drifted apart. */
				log.warn(
					"[auth/oauth] revoke ok but no watermark written. Token shape unrecognized",
				);
			}
		} catch (err) {
			log.error("[auth/oauth] grant revocation watermark failed", err);
			return new Response(null, { status: 500 });
		}
	}

	/* The one place this handler replaces Better Auth's answer. An authorize
	 * request Better Auth can't trust (a client id Nova no longer knows, a
	 * client address it couldn't read) is refused in the BROWSER: a redirect
	 * to `/?error=…` or a bare JSON 4xx. The MCP client that opened the tab
	 * never sees either, so it can't recover on its own, and the person is
	 * left on a page that says nothing useful. Send them to the page that
	 * explains what happened and how to reconnect. Only the classified reason
	 * travels: never the provider's code, its description, or the client id. */
	if (isOAuthAuthorize && isBrowserNavigation(req)) {
		const reason = classifyAuthorizeResponse({
			status: response.status,
			location: response.headers.get("location"),
			requestUrl: req.url,
			body: await readErrorBody(response),
		});
		if (reason) {
			await response.body?.cancel();
			return new Response(null, {
				status: 302,
				headers: { location: connectionIssueUrl(reason) },
			});
		}
	}

	return response;
};

export { handler as GET, handler as POST };
