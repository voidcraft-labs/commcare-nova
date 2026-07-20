/**
 * Better Auth session-cookie name + signer, outside Better Auth's router.
 *
 * Two consumers mint session cookies without driving real Google OAuth: the
 * Playwright smoke suite (`e2e/lib/session.ts` builds a `storageState` from a
 * seeded session row) and the local-dev agent login route
 * (`app/api/dev/login/route.ts` sets the cookie directly). Both write a
 * session row through Better Auth's own adapter and sign the cookie here.
 *
 * The cookie value is signed exactly like `better-call`'s `signCookieValue`
 * (the signer Better Auth calls under the hood): the raw session token, a `.`,
 * then the base64 HMAC-SHA256 of the token keyed by `BETTER_AUTH_SECRET`, with
 * the whole pair URL-encoded. `crypto.createHmac(...).digest("base64")` is
 * byte-identical to better-call's `btoa(String.fromCharCode(...bytes))`.
 *
 * This reproduction is intentionally NOT imported from better-call (its
 * `exports` map doesn't expose the function, and we don't want a deep-path
 * import that a version bump silently moves). The contract is instead pinned by
 * an end-to-end guard: `lib/db/__tests__/sessionCookie.integration.test.ts`
 * mints with this helper and asserts `auth.api.getSession` accepts it, so a
 * better-auth/better-call signing change fails loudly in CI rather than here.
 */
import { createHmac } from "node:crypto";

/** Cookie name with no `advanced.cookiePrefix` override — `prefix.session_token`, prefix `better-auth`. */
const SESSION_COOKIE_BASENAME = "better-auth.session_token";

/**
 * The session cookie name for a given base URL.
 *
 * Better Auth swaps to the `__Secure-` prefix (and `secure: true`) whenever the
 * resolved base URL is `https://` — so a smoke run against production
 * (`https://commcare.app`) must look for `__Secure-better-auth.session_token`,
 * while a localhost run uses the bare name. Getting this wrong silently makes
 * every authed request anonymous.
 */
export function sessionCookieName(baseUrl: string): string {
	return baseUrl.startsWith("https://")
		? `__Secure-${SESSION_COOKIE_BASENAME}`
		: SESSION_COOKIE_BASENAME;
}

/**
 * Sign a session token into a Better Auth cookie value.
 *
 * `value = encodeURIComponent(`${token}.${base64(HMAC_SHA256(token, secret))}`)`.
 * Standard base64 (not base64url), URL-encoded as a whole.
 */
export function signSessionCookie(token: string, secret: string): string {
	const signature = createHmac("sha256", secret).update(token).digest("base64");
	return encodeURIComponent(`${token}.${signature}`);
}
