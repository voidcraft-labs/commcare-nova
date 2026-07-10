/**
 * Auth utilities for API route handlers and Server Components.
 *
 * All routes require authenticated sessions (Google OAuth, restricted
 * to the email-domain allowlist enforced by the `databaseHooks` block
 * in `lib/auth.ts`). The server-side AI_GATEWAY_API_KEY (Vercel AI
 * Gateway) is used for all LLM calls.
 *
 * User identity is Better Auth's built-in `session.user.id` — always
 * present on valid sessions, no custom session fields needed.
 */

import * as Sentry from "@sentry/nextjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { ApiError } from "./apiError";
import { getAuth, type Session } from "./auth";
import { getAuthDb } from "./auth/db";
import { ensurePersonalProject } from "./auth/provisionProject";
import { isUserActive } from "./db/api-keys";
import { AppAccessError, resolveProjectAccess } from "./db/appAccess";
import { log } from "./logger";

/**
 * Live check that a session's user is still active (not banned or deleted).
 * Better Auth's compact cookie cache (5-minute `maxAge`, configured at
 * `lib/auth.ts::session.cookieCache`) means a raw `getSession` can return a
 * still-valid-looking payload for up to that window after a ban or deletion
 * revoked the underlying session row (CWE-613). The MCP api-key route
 * (`api-key-auth.ts`) and the api-key Server Actions (`api-key-actions.ts`)
 * already gate on this `isUserActive` read; this is the shared primitive that
 * extends the same revocation lock to EVERY authenticated surface.
 *
 * It runs at the two session choke points — `getSessionSafe` (route handlers)
 * and `getSession` (RSC + Server Actions) — so a revoked user is denied on
 * every page, API route, and action within the cache window, not just the
 * costly/mutating ones. The cost is one Postgres read per authenticated
 * request (the cookie cache still spares the Better Auth session-row read);
 * unauthenticated requests pay nothing (no session → no lookup).
 *
 * A definitive `false` (banned/deleted) DENIES; a lookup ERROR fails OPEN (see
 * the body) — denying every authenticated request on a transient Postgres
 * blip would be a self-inflicted outage, far worse than the bounded revocation
 * gap that only reopens while Postgres itself is unreachable.
 */
async function sessionUserIsActive(session: Session): Promise<boolean> {
	// During admin impersonation `session.user` is the impersonated TARGET, so
	// gate revocation on the ACTING ADMIN (`impersonatedBy`): banning a user
	// then impersonating them to investigate must NOT read as signed-out, and a
	// banned admin still can't impersonate. Single-sourced here so the two
	// session choke points can't drift on the impersonation rule.
	const userId = session.session.impersonatedBy ?? session.user.id;
	try {
		return await isUserActive(userId);
	} catch (err) {
		// Fail OPEN on a lookup ERROR — distinct from a definitive `false`
		// (banned/deleted), which still denies. Because this now runs on EVERY
		// authenticated request (RSC renders, API routes, Server Actions,
		// including the per-inline-image media route), denying on a transient
		// Postgres blip would mass-sign-out the whole user base and break every
		// media load — strictly worse than the bounded revocation gap that
		// reopens only during an outage, when the app is already degraded. Use
		// `log.warn` (Cloud-Logging-only, NOT mirrored to Sentry) so an outage
		// doesn't also flood Sentry with one event per authenticated request.
		log.warn("[auth] user-status lookup failed; allowing (fail-open)", {
			userId,
			err: err instanceof Error ? err.message : String(err),
		});
		return true;
	}
}

// ── Sentry user attribution ─────────────────────────────────────────

/**
 * Attach the authenticated user to Sentry's per-request isolation scope so
 * every event captured while serving this request — a thrown route error the
 * SDK auto-instruments, or a `log.error` mirror from `lib/logger.ts` — is
 * attributed to the person who hit it, by name and email rather than just an
 * IP. Set at the two session choke points below (`getSessionSafe` for route
 * handlers, `getSession` for Server Components) so no individual handler has
 * to remember to.
 *
 * Email + name ship even though `sentry.server.config.ts` runs with
 * `sendDefaultPii: false`: that flag governs only the PII the SDK harvests on
 * its own (cookies, request headers, inferred IP) — an explicitly set user is
 * always sent. This is the controlled inverse of why PII is off there: we ship
 * the identity we choose, never the session cookie.
 */
function identifySentryUser(session: Session): void {
	Sentry.setUser({
		id: session.user.id,
		email: session.user.email,
		username: session.user.name,
	});
	/* During admin impersonation `session.user` is the impersonated target, so
	 * the event is correctly attributed to whose data context it happened in —
	 * but record the acting admin too, so an error in an impersonation session
	 * is traceable to who actually triggered it. Absent on normal sessions. */
	if (session.session.impersonatedBy) {
		Sentry.setTag("impersonatedBy", session.session.impersonatedBy);
	}
}

// ── Caller IP ───────────────────────────────────────────────────────

// Re-exported from the dependency-free `@/lib/callerIp` leaf: the MCP
// API-key route imports the helper directly from there to avoid dragging
// this barrel's heavy Better Auth + DB-pool graph into the request path.
export { callerIpFromHeaders } from "./callerIp";

// ── Gateway-key resolution for chat-API routes ──────────────────────

/* Naming: `resolveGatewayKey` (and the `GatewayKey*` types below)
 * disambiguate from Nova's user-minted MCP API keys (see
 * `lib/db/api-keys.ts` and `app/(app)/settings/api-key-actions.ts`).
 * Both surfaces use "API key" in product copy; the prefix here pins
 * which one each function operates on so callers don't have to read
 * the file context to know. */

/** Successful resolution — server-shared AI Gateway key + authenticated session. */
interface GatewayKeyResolved {
	ok: true;
	apiKey: string;
	session: Session;
}

/** Failed resolution — error message and HTTP status code. */
interface GatewayKeyError {
	ok: false;
	error: string;
	status: number;
}

type GatewayKeyResult = GatewayKeyResolved | GatewayKeyError;

/**
 * Resolve the server-shared Vercel AI Gateway API key for an authenticated
 * request hitting the chat surface (`/api/chat`). Requires a valid
 * session and `AI_GATEWAY_API_KEY` in the environment. Returns a
 * discriminated union so callers can handle errors without try/catch.
 *
 * Distinct from the user-minted Nova API keys managed via
 * `auth.api.{create,delete,update,verify}ApiKey` in
 * `app/(app)/settings/api-key-actions.ts` — those authenticate the MCP
 * surface; this function authorizes server-to-gateway LLM calls.
 */
export async function resolveGatewayKey(
	req: Request,
): Promise<GatewayKeyResult> {
	// `getSessionSafe` already applies the live banned/deleted revocation lock,
	// so a revoked user reads as signed-out here (no paid model call).
	const session = await getSessionSafe(req);
	if (!session) {
		return {
			ok: false,
			error: "Authentication required. Sign in with Google.",
			status: 401,
		};
	}

	touchUser(session.user.id);

	const serverKey = process.env.AI_GATEWAY_API_KEY;
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
	// `getSessionSafe` already applies the live banned/deleted revocation lock.
	const session = await getSessionSafe(req);
	if (!session) {
		throw new ApiError("Authentication required", 401);
	}
	touchUser(session.user.id);
	return session;
}

/**
 * Read the caller's admin status from `auth_user` directly, bypassing
 * Better Auth's session-cookie cache (up to 5 minutes). Both the API gate
 * (`requireAdmin`) and the RSC gate (`requireAdminAccess`) authorize on
 * this fresh read so an admin demotion takes effect on the next request,
 * not after the cache window elapses.
 */
async function readsFreshAsAdmin(userId: string): Promise<boolean> {
	const db = await getAuthDb();
	const row = await db
		.selectFrom("auth_user")
		.select("role")
		.where("id", "=", userId)
		.executeTakeFirst();
	return row?.role === "admin";
}

/**
 * Require an admin session or throw a 403.
 *
 * Authorizes on the role read FRESH from `auth_user`, not the cached
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
			const auth = await getAuth();
			await auth.api.signOut({ headers: req.headers }).catch(() => {});
		}
		throw new ApiError("Admin access required", 403);
	}
	return session;
}

/**
 * Safely attempt to retrieve the session from a request.
 *
 * Returns null instead of throwing when auth headers are missing or invalid —
 * AND when the resolved user has been banned or deleted ({@link
 * sessionUserIsActive}), so the universal revocation lock applies to every API
 * route that authenticates through here.
 */
export async function getSessionSafe(req: Request): Promise<Session | null> {
	try {
		const auth = await getAuth();
		const result = await auth.api.getSession({ headers: req.headers });
		if (!result) return null;
		if (!(await sessionUserIsActive(result))) return null;
		identifySentryUser(result);
		return result;
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
 * caching, each would be a separate database read for the same session.
 *
 * Returns null if not authenticated — use when authentication is optional
 * (e.g. the landing page checking whether to redirect). Also returns null when
 * the resolved user has been banned or deleted ({@link sessionUserIsActive}),
 * so the universal revocation lock applies to every RSC page and Server Action
 * that authenticates through here, not just the costly/mutating ones.
 */
export const getSession = cache(async (): Promise<Session | null> => {
	/* Bail out of static prerendering before touching auth or the database.
	 * Without this, `getAuth()` initializes Better Auth (reads BETTER_AUTH_SECRET,
	 * opens the Postgres pool) before `headers()` signals dynamic rendering — the
	 * missing secret throws a warning and the session read hangs in Cloud Build
	 * where there's no database. */
	await connection();
	try {
		const auth = await getAuth();
		const session =
			(await auth.api.getSession({ headers: await headers() })) ?? null;
		if (!session) return null;
		if (!(await sessionUserIsActive(session))) return null;
		identifySentryUser(session);
		return session;
	} catch {
		return null;
	}
});

/**
 * The caller's active Project id for tenancy-scoped reads (the app list, etc.).
 *
 * Prefers the session's stamped `activeOrganizationId` (set at session create),
 * falling back to the user's personal Project — self-healing for sessions
 * minted before Projects shipped, which never got the stamp. The fallback is a
 * cheap indexed get-or-create, so it's safe to call per request.
 *
 * `cache()`-wrapped (like `getSession`) so the layout + page both calling it in
 * one render pass share a single resolution — keyed on the `session` object,
 * which `getSession`'s own cache keeps stable within a request.
 */
export const resolveActiveProjectId = cache(
	async function resolveActiveProjectId(session: Session): Promise<string> {
		const active = session.session.activeOrganizationId;
		if (active) {
			/* Re-check membership: `organization.setActive` lets a user stamp a shared
			 * Project active, and a later removal leaves that stale stamp on their
			 * session until it's re-minted. Don't let it grant list/create access to a
			 * Project they've left — fall through to their personal one. */
			try {
				await resolveProjectAccess(session.user.id, active, "view");
				return active;
			} catch (err) {
				if (!(err instanceof AppAccessError)) throw err;
				// The stamped active Project is no longer accessible — membership
				// was revoked since the session was minted. Fall through to the
				// personal Project (secure: correctly scoped), but LOG it:
				// otherwise the user's shared apps silently vanish from their list
				// with no trace. The stale stamp clears on the next session
				// re-mint; the Project switcher reflects the active Project.
				log.warn(
					"[auth] active Project no longer accessible — falling back to personal",
					{ userId: session.user.id, staleProjectId: active },
				);
			}
		}
		return ensurePersonalProject(session.user.id);
	},
);

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
 * Reads the auth user's `role` directly from `auth_user` to bypass the
 * 5-minute session cookie cache, ensuring demotions take effect immediately.
 * If admin access was revoked, the session is deleted from Postgres (live
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

	/* Authorize on the fresh `auth_user` read (bypasses the cookie cache),
	 * so admin demotions take effect on the next page load, not after the
	 * 5-minute cache window. */
	if (!(await readsFreshAsAdmin(session.user.id))) {
		/* Live revocation — sign out clears the session row and wipes auth
		 * cookies so stale role data can't linger. */
		const auth = await getAuth();
		await auth.api.signOut({ headers: await headers() });
		redirect("/");
	}
	return session;
}

// ── Activity Tracking ──────────────────────────────────────────────

/**
 * Bump `lastActiveAt` on `auth_user`. Fire-and-forget on every authenticated
 * request — a failure must never block the request, consistent with
 * `requireAdminAccess()` which also reads `auth_user` directly.
 *
 * Logs at WARN (Cloud-Logging-only, NOT mirrored to Sentry) for the same reason
 * `sessionUserIsActive` does: this runs on EVERY authenticated request, so a
 * Postgres slowdown / pool-saturation window would otherwise emit one Sentry
 * event per request and bury real errors. A lost activity timestamp is benign.
 */
function touchUser(userId: string): void {
	void getAuthDb()
		.then((db) =>
			db
				.updateTable("auth_user")
				.set({ lastActiveAt: new Date() })
				.where("id", "=", userId)
				.execute(),
		)
		.catch((err) =>
			log.warn("[touchUser] auth_user lastActiveAt write failed", err),
		);
}
