/**
 * Auth utilities for API route handlers.
 *
 * Provides the dual-mode API key resolution pattern: authenticated users get
 * the server-side ANTHROPIC_API_KEY, unauthenticated users must provide their
 * own key (BYOK). This keeps the resolution logic in one place, shared across
 * all routes that need an Anthropic key (chat, models, compile).
 */
import { auth, type Session } from './auth'
import { ApiError } from './apiError'
import { isUserAdmin } from './db/users'

/** Successful key resolution — includes the key and optional session for downstream use. */
interface ApiKeyResolved {
  ok: true
  apiKey: string
  session: Session | null
}

/** Failed key resolution — includes an error message and HTTP status code. */
interface ApiKeyError {
  ok: false
  error: string
  status: number
}

type ApiKeyResult = ApiKeyResolved | ApiKeyError

/**
 * Resolve the effective Anthropic API key for a request.
 *
 * Priority:
 * 1. Authenticated session → use server-side ANTHROPIC_API_KEY from env
 * 2. BYOK key in request body → use that directly
 * 3. Neither → reject with 401
 *
 * The server key is only used when ANTHROPIC_API_KEY is set in the environment.
 * If a user is authenticated but the server key isn't configured, falls back to
 * BYOK — this supports local dev where auth is configured but no server key is set.
 */
export async function resolveApiKey(req: Request, bodyApiKey?: string): Promise<ApiKeyResult> {
  const session = await getSessionSafe(req)

  /* Authenticated user — prefer server-side key */
  if (session) {
    const serverKey = process.env.ANTHROPIC_API_KEY
    if (serverKey) {
      return { ok: true, apiKey: serverKey, session }
    }
    /* Server key not configured — fall through to BYOK if available */
  }

  /* BYOK fallback */
  if (bodyApiKey) {
    return { ok: true, apiKey: bodyApiKey, session }
  }

  /* No authentication and no key provided */
  return {
    ok: false,
    error: session
      ? 'Server API key not configured. Please provide your own API key in Settings.'
      : 'Authentication required. Sign in with Google or provide an API key.',
    status: 401,
  }
}

/**
 * Require an authenticated session or throw a 401.
 *
 * Used by project API routes that only serve authenticated users — no
 * BYOK fallback, no API key involved. Throws an error suitable for
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
 * This allows routes to gracefully fall back to BYOK mode.
 */
export async function getSessionSafe(req: Request): Promise<Session | null> {
  try {
    const result = await auth.api.getSession({ headers: req.headers })
    return result ?? null
  } catch {
    return null
  }
}
