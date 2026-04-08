/**
 * Auth utilities for API route handlers and Server Components.
 *
 * All routes require authenticated sessions (@dimagi.com Google OAuth).
 * The server-side ANTHROPIC_API_KEY is used for all LLM calls.
 *
 * User identity is the app's own UUID (`session.session.userId`), written
 * to the Better Auth session on every sign-in. Pre-migration sessions
 * that lack userId are rejected with a 401 — the user re-authenticates,
 * and the after-hook populates the field.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { ApiError } from "./apiError";
import { getAuth, type Session } from "./auth";
import { isUserAdmin, touchUser } from "./db/users";

// ── Session User ID ──────────────────────────────────────────────────

/**
 * Extract userId from session. Throws 401 for pre-migration sessions
 * that lack userId, forcing re-auth so the after-hook provisions it.
 */
function getSessionUserId(session: Session): string {
	const userId = session.session?.userId;
	if (!userId) {
		throw new ApiError("Session expired — please sign in again", 401);
	}
	return userId;
}

// ── API Route Auth ──────────────────────────────────────────────────

/** Successful key resolution — includes the API key and authenticated session. */
interface ApiKeyResolved {
	ok: true;
	apiKey: string;
	session: Session;
}

/** Failed key resolution — includes an error message and HTTP status code. */
interface ApiKeyError {
	ok: false;
	error: string;
	status: number;
}

type ApiKeyResult = ApiKeyResolved | ApiKeyError;

/**
 * Resolve the Anthropic API key for an authenticated request.
 *
 * Requires an authenticated session and a configured ANTHROPIC_API_KEY.
 * Returns a discriminated union so callers can handle errors without try/catch.
 */
export async function resolveApiKey(req: Request): Promise<ApiKeyResult> {
	const session = await getSessionSafe(req);
	if (!session) {
		return {
			ok: false,
			error: "Authentication required. Sign in with Google.",
			status: 401,
		};
	}

	const userId = session.session?.userId;
	if (!userId) {
		return {
			ok: false,
			error: "Session expired — please sign in again.",
			status: 401,
		};
	}

	touchUser(userId);

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
	touchUser(getSessionUserId(session));
	return session;
}

/**
 * Require an admin session or throw a 403.
 *
 * First checks for an authenticated session (401 if missing), then reads
 * the user's Firestore document to verify `role === 'admin'` (403 if not).
 * Used by all admin API routes.
 */
export async function requireAdmin(req: Request): Promise<Session> {
	const session = await requireSession(req);
	if (!(await isUserAdmin(getSessionUserId(session)))) {
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
	touchUser(getSessionUserId(session));
	return session;
}

/**
 * Require an admin session in a Server Component.
 *
 * Checks the app's Firestore user doc directly (not the session's cached
 * `isAdmin`) so demotions take effect immediately. If admin access was
 * revoked, the session is deleted from Firestore (live revocation) and
 * the user is redirected to the landing page to re-authenticate. The
 * stale auth cookies become harmless — the next `getSession()` returns
 * null because the session no longer exists in the database.
 */
export async function requireAdminAccess(): Promise<Session> {
	const session = await requireAuth();
	if (!(await isUserAdmin(getSessionUserId(session)))) {
		/* Live revocation — sign out clears the session from Firestore and
		 * wipes auth cookies so stale `isAdmin` can't linger. */
		await getAuth().api.signOut({ headers: await headers() });
		redirect("/");
	}
	return session;
}
