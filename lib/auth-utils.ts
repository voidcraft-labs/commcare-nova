/**
 * Auth utilities for API route handlers.
 *
 * All routes require authenticated sessions (@dimagi.com Google OAuth).
 * The server-side ANTHROPIC_API_KEY is used for all LLM calls.
 */
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, type Session } from './auth'
import { ApiError } from './apiError'
import { isUserAdmin } from './db/users'

/** Successful key resolution — includes the API key and authenticated session. */
interface ApiKeyResolved {
  ok: true
  apiKey: string
  session: Session
}

/** Failed key resolution — includes an error message and HTTP status code. */
interface ApiKeyError {
  ok: false
  error: string
  status: number
}

type ApiKeyResult = ApiKeyResolved | ApiKeyError

/**
 * Resolve the Anthropic API key for an authenticated request.
 *
 * Requires an authenticated session and a configured ANTHROPIC_API_KEY.
 * Returns a discriminated union so callers can handle errors without try/catch.
 */
export async function resolveApiKey(req: Request): Promise<ApiKeyResult> {
  const session = await getSessionSafe(req)
  if (!session) {
    return { ok: false, error: 'Authentication required. Sign in with Google.', status: 401 }
  }

  const serverKey = process.env.ANTHROPIC_API_KEY
  if (!serverKey) {
    return { ok: false, error: 'Server API key not configured.', status: 500 }
  }

  return { ok: true, apiKey: serverKey, session }
}

/**
 * Require an authenticated session or throw a 401.
 *
 * Used by API routes that require authentication. Throws an error suitable for
 * direct catch by `handleApiError`.
 */
export async function requireSession(req: Request): Promise<Session> {
  const session = await getSessionSafe(req)
  if (!session) {
    throw new ApiError('Authentication required', 401)
  }
  return session
}

/**
 * Require an admin session or throw a 403.
 *
 * First checks for an authenticated session (401 if missing), then reads
 * the user's Firestore document to verify `role === 'admin'` (403 if not).
 * Used by all admin API routes.
 */
export async function requireAdmin(req: Request): Promise<Session> {
  const session = await requireSession(req)
  if (!await isUserAdmin(session.user.email)) {
    throw new ApiError('Admin access required', 403)
  }
  return session
}

/**
 * Safely attempt to retrieve the session from a request.
 *
 * Returns null instead of throwing when auth headers are missing or invalid.
 */
export async function getSessionSafe(req: Request): Promise<Session | null> {
  try {
    const result = await auth.api.getSession({ headers: req.headers })
    return result ?? null
  } catch {
    return null
  }
}

// ── RSC Auth Functions ─────────────���─────────────────────────────────
// Server Component equivalents of the route handler functions above.
// Use `await headers()` from next/headers instead of `req.headers`.

/**
 * Get the session in a Server Component or Server Action.
 *
 * Returns null if not authenticated — use when authentication is optional
 * (e.g. the landing page checking whether to redirect).
 */
export async function getSession(): Promise<Session | null> {
  try {
    return await auth.api.getSession({ headers: await headers() }) ?? null
  } catch {
    return null
  }
}

/**
 * Require an authenticated session in a Server Component.
 *
 * Redirects to the landing page if not authenticated. Use for pages that
 * require sign-in (builds, settings).
 */
export async function requireAuth(): Promise<Session> {
  const session = await getSession()
  if (!session) redirect('/')
  return session
}

/**
 * Require an admin session in a Server Component.
 *
 * Redirects to /builds if authenticated but not admin, or to / if not
 * authenticated at all. Use for the admin layout gate.
 */
export async function requireAdminAccess(): Promise<Session> {
  const session = await requireAuth()
  if (session.user.isAdmin !== true) redirect('/builds')
  return session
}
