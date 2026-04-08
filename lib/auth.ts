/**
 * Better Auth — server-side authentication instance.
 *
 * Persistent session management backed by Firestore (via better-auth-firestore).
 * Google OAuth sign-in — domain restriction is enforced by the GCP OAuth
 * consent screen (internal-only), not application code. Authenticated users
 * share the server-side ANTHROPIC_API_KEY.
 *
 * Auth collections live in their own Firestore namespace (auth_users,
 * auth_sessions, auth_accounts, auth_verifications) to avoid collision
 * with the app's existing `users/{email}` document hierarchy.
 *
 * Required env vars:
 *   BETTER_AUTH_SECRET   — cookie signing secret (generate with `openssl rand -base64 32`)
 *   GOOGLE_CLIENT_ID     — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL      — Base URL (e.g. http://localhost:3000 or production URL).
 *                          Optional in dev — Better Auth auto-detects from requests.
 */
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { firestoreAdapter } from "better-auth-firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "./db/firestore";
import { provisionUser } from "./db/users";

/* ── Startup guards ─────────────────────────────────────────────────
 * Fail fast if required OAuth credentials are missing. Without these the
 * server starts but every sign-in attempt produces a cryptic OAuth error.
 * Checked at module load time so misconfigured deploys surface immediately. */
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (process.env.NODE_ENV === "production") {
	if (!googleClientId || !googleClientSecret) {
		throw new Error(
			"GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in production",
		);
	}
}

export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,

	/**
	 * Firestore database for auth state (users, sessions, accounts).
	 *
	 * Reuses the app's existing Firestore singleton — same project, same
	 * credentials. Collections are prefixed with `auth_` to namespace them
	 * away from the app's `users/{email}` subcollection hierarchy.
	 *
	 * The type cast bridges `@google-cloud/firestore` → `firebase-admin/firestore`.
	 * They're the same underlying class — firebase-admin re-exports it.
	 */
	database: firestoreAdapter({
		firestore: getDb() as unknown as Firestore,
		collections: {
			users: "auth_users",
			sessions: "auth_sessions",
			accounts: "auth_accounts",
			verificationTokens: "auth_verifications",
		},
	}),

	/**
	 * Trusted origins for CSRF validation.
	 *
	 * The baseURL origin is automatically trusted, but we declare it
	 * explicitly so CSRF validation doesn't silently break if
	 * BETTER_AUTH_URL is misconfigured or unset in a deploy.
	 */
	trustedOrigins: process.env.BETTER_AUTH_URL
		? [process.env.BETTER_AUTH_URL]
		: [],

	/**
	 * Rate limiting — persistent storage shared across Cloud Run instances.
	 *
	 * Default "memory" storage resets on restart and is per-instance, making
	 * it effectively useless on Cloud Run. "database" stores counters in
	 * Firestore so all instances share the same rate limit state. Custom
	 * rules tighten sensitive auth endpoints beyond the 100 req/10s default.
	 */
	rateLimit: {
		storage: "database",
		customRules: {
			"/api/auth/callback/:path": { window: 60, max: 10 },
		},
	},

	session: {
		expiresIn: 60 * 60 * 24 * 2, // 2 days max lifetime
		updateAge: 60 * 60 * 12, // refresh every 12h of activity

		/**
		 * Session cookie cache — avoids a Firestore read on every request.
		 *
		 * Compact strategy (Base64url + HMAC) has the smallest cookie payload.
		 * 5-minute maxAge means session data is re-fetched from Firestore at
		 * most every 5 minutes. Admin checks (`requireAdminAccess`) bypass
		 * the cache entirely — they read Firestore directly — so cached
		 * `isAdmin` staleness is a display-only concern, not a security one.
		 */
		cookieCache: {
			enabled: true,
			maxAge: 60 * 5, // 5 minutes
			strategy: "compact",
		},

		/**
		 * Admin role stored on the session record in Firestore.
		 *
		 * Synced from the app's user doc (`users/{email}.role`) on every sign-in
		 * via the `after` hook calling `internalAdapter.updateSession`. Promotions
		 * happen via the Firestore console (setting `role` to 'admin') — the next
		 * sign-in picks up the change.
		 */
		additionalFields: {
			isAdmin: {
				type: "boolean",
			},
		},
	},

	socialProviders: {
		google: {
			clientId: googleClientId ?? "",
			clientSecret: googleClientSecret ?? "",
		},
	},

	/**
	 * Encrypt OAuth access/refresh tokens at rest with AES-256-GCM.
	 *
	 * Even though we only use Google OAuth for sign-in (not API access on
	 * behalf of users), encrypting stored tokens is defense-in-depth — if
	 * the Firestore `auth_accounts` collection is ever exposed, raw tokens
	 * can't be reused.
	 */
	account: {
		encryptOAuthTokens: true,
	},

	/**
	 * Cloud Run proxy and IP tracking configuration.
	 *
	 * Cloud Run sits behind a Google load balancer that sets x-forwarded-for.
	 * Without this, Better Auth sees the LB's IP for every request — rate
	 * limiting treats all users as a single client, and IP-based security
	 * auditing is useless.
	 */
	advanced: {
		ipAddress: {
			ipAddressHeaders: ["x-forwarded-for"],
		},
	},

	hooks: {
		/**
		 * User provisioning + admin sync on sign-in.
		 *
		 * Fires after the OAuth callback completes successfully. Two responsibilities:
		 *
		 * 1. Provision the app's Firestore user doc (`users/{email}`) — this is the
		 *    app's own user record for usage tracking, admin dashboard, etc.
		 *
		 * 2. Sync admin status from the app's user doc to the Better Auth session
		 *    via `internalAdapter.updateSession`. Uses the internal adapter directly
		 *    because the public API requires an authenticated session cookie in the
		 *    headers, but during the OAuth callback the cookie hasn't been sent to
		 *    the client yet — `ctx.headers` only has the inbound redirect headers.
		 *    Promotions happen via the Firestore console (setting `role` to 'admin')
		 *    — the next sign-in picks it up.
		 */
		after: createAuthMiddleware(async (ctx) => {
			if (!ctx.path.startsWith("/callback/")) return;
			const newSession = ctx.context.newSession;
			if (!newSession) return;

			/* Provision the app's user doc and read admin status from the same
			 * Firestore read — avoids a redundant second lookup. */
			let isAdmin = false;
			try {
				isAdmin = await provisionUser(
					newSession.user.email,
					newSession.user.name,
					newSession.user.image ?? null,
				);
			} catch (err) {
				/* Fail closed — if Firestore is down, user is not admin. Log so
				 * transient failures during sign-in are observable. */
				console.error("[auth] Failed to provision user on sign-in:", err);
			}

			await ctx.context.internalAdapter.updateSession(
				newSession.session.token,
				{ isAdmin },
			);
		}),
	},
});

/** Type-safe session type exported for use in route handlers. */
export type Session = typeof auth.$Infer.Session;
