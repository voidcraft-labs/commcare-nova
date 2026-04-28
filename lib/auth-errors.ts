/**
 * Stable, URL-safe codes for sign-in failures that Nova explicitly emits.
 *
 * Better Auth's OAuth callback handler has no transport back to the
 * browser other than the redirect URL — when `databaseHooks.user.create.before`
 * throws an `APIError`, the message is serialized into `?error=…` on the
 * redirect to `errorCallbackURL`. That is the OAuth standard (RFC 6749
 * §4.1.2.1) and is unavoidable.
 *
 * What IS our call is the shape of the value we put in that param. A
 * free-form prose message there forces the landing page to substring-match
 * a sentence — and the message string in the hook becomes an implicit,
 * un-typed contract with the UI. This module turns that into a typed
 * shared constant: the hook throws with one of these codes, the landing
 * page's formatter imports the same codes and maps each to a user-facing
 * sentence. TypeScript catches a typo on either side at build time.
 *
 * Codes are lowercase snake_case so Better Auth's `result.error.split(" ").join("_")`
 * serialization in `callback.mjs` is a no-op and the value reaches the
 * URL unmodified — no underscore↔space round-tripping is needed in the
 * formatter.
 *
 * Better Auth's own internal codes (`state_mismatch`, `invalid_code`,
 * `please_restart_the_process`, etc.) are not mirrored here — they are
 * external contracts we do not control. The formatter handles them by
 * prefix in one place and falls back to a generic message for anything
 * unrecognized, so a new Better Auth error surface never silently shows
 * the wrong sentence.
 */
export const SIGN_IN_ERROR = {
	/** Email domain is not in `ALLOWED_EMAIL_DOMAINS` (see `lib/auth.ts`). */
	domainRejected: "domain_rejected",
} as const;

/** Union of every code Nova explicitly emits via `SIGN_IN_ERROR`. */
export type SignInErrorCode =
	(typeof SIGN_IN_ERROR)[keyof typeof SIGN_IN_ERROR];
