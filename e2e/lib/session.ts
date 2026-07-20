/**
 * Playwright `storageState` assembly for the smoke suite's forged session.
 *
 * The smoke tests don't drive real Google OAuth (the sign-in is hard-gated to
 * `@dimagi.com` / `@dimagi-ai.com` and CI has no Workspace account). Instead a
 * session row is written straight into Postgres (`e2e/seed.ts`) and this module
 * wraps it in the cookie Better Auth would have set on a real login, so
 * Playwright can present an authenticated request.
 *
 * The cookie name + signature come from `lib/auth/sessionCookie.ts` — the one
 * signer shared with the local-dev agent login route, contract-pinned by
 * `lib/db/__tests__/sessionCookie.integration.test.ts`.
 */
import { sessionCookieName, signSessionCookie } from "@/lib/auth/sessionCookie";

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
