/**
 * Auth utilities for API route handlers and Server Components.
 *
 * All routes require authenticated sessions (Google OAuth, restricted
 * to the email-domain allowlist enforced by the `databaseHooks` block
 * in `lib/auth.ts`). The server-side ANTHROPIC_API_KEY is used for all
 * LLM calls.
 *
 * User identity is Better Auth's built-in `session.user.id` — always
 * present on valid sessions, no custom session fields needed.
 */

import { isValidIP, normalizeIP } from "@better-auth/core/utils/ip";
import { FieldValue } from "@google-cloud/firestore";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { ApiError } from "./apiError";
import { getAuth, type Session } from "./auth";
import { getDb } from "./db/firestore";
import { log } from "./logger";

// ── Caller IP ───────────────────────────────────────────────────────

/**
 * Extract the caller's IP from a `Headers` object for audit-log
 * payloads. Reads the proxy-stamped `x-nova-client-ip` header that
 * `proxy.ts` populates from `X-Forwarded-For`'s trusted suffix; the
 * proxy strips any client-supplied value first, so anything reaching
 * here under that name is guaranteed proxy-derived (the leftmost
 * spoofable region of XFF cannot reach this code path). `isValidIP`
 * rejects anything that isn't a parseable IPv4/IPv6 address (defends
 * against an upstream regression that lets a malformed value through),
 * and `normalizeIP` collapses equivalent representations so log
 * queries pivot on one canonical form. Returns `"unknown"` when the
 * header is absent (proxy didn't run for this request — tests, dev
 * paths bypassing the middleware) or the value fails validation.
 *
 * The Headers parameter lets the same helper serve route handlers
 * (passing `req.headers`) and Server Components / Server Actions
 * (passing `await headers()`) — the async vs sync seam stays at the
 * call site, where it belongs.
 */
export function callerIpFromHeaders(reqHeaders: Headers): string {
	const trusted = reqHeaders.get("x-nova-client-ip");
	if (!trusted || !isValidIP(trusted)) return "unknown";
	return normalizeIP(trusted);
}

// ── Anthropic-key resolution for chat-API routes ────────────────────

/* Naming: `resolveAnthropicKey` (and the `AnthropicKey*` types below)
 * disambiguate from Nova's user-minted MCP API keys (see
 * `lib/db/api-keys.ts` and `app/(app)/settings/api-key-actions.ts`).
 * Both surfaces use "API key" in product copy; the prefix here pins
 * which one each function operates on so callers don't have to read
 * the file context to know. */

/** Successful resolution — server-shared Anthropic key + authenticated session. */
interface AnthropicKeyResolved {
	ok: true;
	apiKey: string;
	session: Session;
}

/** Failed resolution — error message and HTTP status code. */
interface AnthropicKeyError {
	ok: false;
	error: string;
	status: number;
}

type AnthropicKeyResult = AnthropicKeyResolved | AnthropicKeyError;

/**
 * Resolve the server-shared Anthropic API key for an authenticated
 * request hitting the chat surface (`/api/chat`). Requires a valid
 * session and `ANTHROPIC_API_KEY` in the environment. Returns a
 * discriminated union so callers can handle errors without try/catch.
 *
 * Distinct from the user-minted Nova API keys managed via
 * `auth.api.{create,delete,update,verify}ApiKey` in
 * `app/(app)/settings/api-key-actions.ts` — those authenticate the MCP
 * surface; this function authorizes server-to-Anthropic LLM calls.
 */
export async function resolveAnthropicKey(
	req: Request,
): Promise<AnthropicKeyResult> {
	const session = await getSessionSafe(req);
	if (!session) {
		return {
			ok: false,
			error: "Authentication required. Sign in with Google.",
			status: 401,
		};
	}

	touchUser(session.user.id);

	const serverKey = process.env.ANTHROPIC_API_KEY;
	if (!serverKey) {
		return { ok: false, error: "Server API key not configured.", status: 500 };
	}

	return { ok: true, apiKey: serverKey, session };
}

/**
 * Require an authenticated session or throw a 401.
 *
 * Used by API routes that require authentication. Throws an error suitable for
 * direct catch by `handleApiError`. Also updates the user's activity timestamp
 * so the admin dashboard reflects actual app usage, not just chat activity.
 */
export async function requireSession(req: Request): Promise<Session> {
	const session = await getSessionSafe(req);
	if (!session) {
		throw new ApiError("Authentication required", 401);
	}
	touchUser(session.user.id);
	return session;
}

/**
 * Read the caller's admin status from `auth_users` directly, bypassing
 * Better Auth's session-cookie cache (up to 5 minutes). Both the API gate
 * (`requireAdmin`) and the RSC gate (`requireAdminAccess`) authorize on
 * this fresh read so an admin demotion takes effect on the next request,
 * not after the cache window elapses.
 */
async function readsFreshAsAdmin(userId: string): Promise<boolean> {
	const snap = await getDb().collection("auth_users").doc(userId).get();
	return snap.data()?.role === "admin";
}

/**
 * Require an admin session or throw a 403.
 *
 * Authorizes on the role read FRESH from `auth_users`, not the cached
 * `session.user.role` — the session cookie caches for up to 5 minutes, so
 * trusting the cached role would keep a just-demoted admin authorized for
 * the cache window. This matches the RSC admin gate (`requireAdminAccess`),
 * which already reads fresh. Used by all admin API routes.
 */
export async function requireAdmin(req: Request): Promise<Session> {
	const session = await requireSession(req);
	/* Block impersonated sessions from admin endpoints — even if the
	 * impersonated user happens to be an admin. Prevents impersonation
	 * chains (admin → admin → impersonate again). */
	if (session.session.impersonatedBy) {
		throw new ApiError("Admin access denied during impersonation", 403);
	}
	if (!(await readsFreshAsAdmin(session.user.id))) {
		/* Demotion mid-session — cached role still says admin, the fresh
		 * read disagrees: revoke the session server-side so the stale cookie
		 * can't keep returning a session (live revocation, mirroring
		 * `requireAdminAccess`). Best-effort — a sign-out failure must not
		 * swallow the 403. A user who was NEVER an admin just gets the 403;
		 * we don't sign them out for poking an admin endpoint. */
		if (session.user.role === "admin") {
			await getAuth()
				.api.signOut({ headers: req.headers })
				.catch(() => {});
		}
		throw new ApiError("Admin access required", 403);
	}
	return session;
}

/**
 * Safely attempt to retrieve the session from a request.
 *
 * Returns null instead of throwing when auth headers are missing or invalid.
 */
export async function getSessionSafe(req: Request): Promise<Session | null> {
	try {
		const result = await getAuth().api.getSession({ headers: req.headers });
		return result ?? null;
	} catch {
		return null;
	}
}

// ── RSC Auth Functions ────────────────────────────────────────────────
// Server Component equivalents of the route handler functions above.
// Use `await headers()` from next/headers instead of `req.headers`.

/**
 * Get the session in a Server Component or Server Action.
 *
 * Wrapped in React `cache()` to deduplicate within a single RSC render pass.
 * The root layout and page-level auth checks both call `getSession()` — without
 * caching, each would be a separate Firestore read for the same session.
 *
 * Returns null if not authenticated — use when authentication is optional
 * (e.g. the landing page checking whether to redirect).
 */
export const getSession = cache(async (): Promise<Session | null> => {
	/* Bail out of static prerendering before touching auth or Firestore.
	 * Without this, `getAuth()` initializes Better Auth (reads BETTER_AUTH_SECRET,
	 * creates the Firestore adapter) synchronously before `headers()` signals
	 * dynamic rendering — the missing secret throws a warning and the Firestore
	 * session read hangs indefinitely in Cloud Build where there's no database. */
	await connection();
	try {
		return (
			(await getAuth().api.getSession({ headers: await headers() })) ?? null
		);
	} catch {
		return null;
	}
});

/**
 * Require an authenticated session in a Server Component.
 *
 * Redirects to the landing page if not authenticated. Use for pages that
 * require sign-in (builds, settings). Also updates the user's activity
 * timestamp so page visits are reflected in the admin dashboard.
 */
export async function requireAuth(): Promise<Session> {
	const session = await getSession();
	if (!session) redirect("/");
	touchUser(session.user.id);
	return session;
}

/**
 * Require an admin session in a Server Component.
 *
 * Reads the auth user's `role` directly from `auth_users` to bypass the
 * 5-minute session cookie cache, ensuring demotions take effect immediately.
 * If admin access was revoked, the session is deleted from Firestore (live
 * revocation) and the user is redirected to the landing page. Stale auth
 * cookies become harmless — the next `getSession()` returns null.
 */
export async function requireAdminAccess(): Promise<Session> {
	const session = await requireAuth();

	/* Block impersonated sessions from admin pages — even if the target
	 * user is also an admin. This prevents impersonation chains. */
	if (session.session.impersonatedBy) {
		redirect("/");
	}

	/* Authorize on the fresh `auth_users` read (bypasses the cookie cache),
	 * so admin demotions take effect on the next page load, not after the
	 * 5-minute cache window. */
	if (!(await readsFreshAsAdmin(session.user.id))) {
		/* Live revocation — sign out clears the session from Firestore and
		 * wipes auth cookies so stale role data can't linger. */
		await getAuth().api.signOut({ headers: await headers() });
		redirect("/");
	}
	return session;
}

// ── Activity Tracking ──────────────────────────────────────────────

/**
 * Bump `lastActiveAt` on `auth_users`. Fire-and-forget merge-set on
 * every authenticated request — direct Firestore write, consistent
 * with `requireAdminAccess()` which also reads `auth_users` directly.
 */
function touchUser(userId: string): void {
	getDb()
		.collection("auth_users")
		.doc(userId)
		.set({ lastActiveAt: FieldValue.serverTimestamp() }, { merge: true })
		.catch((err) => log.error("[touchUser] Firestore write failed", err));
}
