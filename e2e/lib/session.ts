/**
 * Better Auth session-cookie minting for the smoke suite.
 *
 * The smoke tests don't drive real Google OAuth (the sign-in is hard-gated to
 * `@dimagi.com` / `@dimagi-ai.com` and CI has no Workspace account). Instead a
 * session row is written straight into Postgres (`e2e/seed.ts`) and this module
 * forges the cookie Better Auth would have set on a real login, so Playwright
 * can present an authenticated request.
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

/** A single Playwright `storageState` cookie entry. */
export interface StorageStateCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Lax" | "Strict" | "None";
	expires: number;
}

/**
 * Build a Playwright `storageState` object carrying a signed session cookie for
 * `baseUrl`. The cookie is `httpOnly`, so it can only be installed via the
 * storage-state / `context.addCookies` path — never `document.cookie`.
 */
export function buildSessionStorageState(args: {
	token: string;
	secret: string;
	baseUrl: string;
}): { cookies: StorageStateCookie[]; origins: never[] } {
	const url = new URL(args.baseUrl);
	const secure = url.protocol === "https:";
	return {
		cookies: [
			{
				name: sessionCookieName(args.baseUrl),
				value: signSessionCookie(args.token, args.secret),
				domain: url.hostname,
				path: "/",
				httpOnly: true,
				secure,
				sameSite: "Lax",
				// Match the server's 2-day session lifetime.
				expires: Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
			},
		],
		origins: [],
	};
}
