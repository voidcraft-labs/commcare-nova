/**
 * Better Auth — server-side authentication singleton.
 *
 * Initialized lazily via `getAuth()` so the Firestore adapter and env var
 * reads happen on the first real request, not at import time. This matters
 * because `next build` imports server modules during page collection —
 * module-level initialization would try to connect to Firestore and read
 * secrets that don't exist in the build environment.
 *
 * Auth collections live in their own Firestore namespace (auth_users,
 * auth_sessions, auth_accounts, auth_verifications) to avoid collision
 * with the app's `users/{userId}` document hierarchy.
 *
 * Required env vars (at runtime, not build time):
 *   BETTER_AUTH_SECRET   — cookie signing secret (generate with `openssl rand -base64 32`)
 *   GOOGLE_CLIENT_ID     — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL      — Base URL (e.g. http://localhost:3000 or production URL).
 *                          Optional in dev — Better Auth auto-detects from requests.
 */
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "./db/firestore";
import { createUserDoc, ensureUserDoc } from "./db/users";

/**
 * Creates the Better Auth instance. Extracted as a named function so
 * `typeof createAuth` captures the full config-specific return type —
 * needed by the client's `inferAdditionalFields` plugin to pick up
 * plugin-added fields (admin plugin's `role` on user, etc.).
 */
function createAuth() {
	return betterAuth({
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL: process.env.BETTER_AUTH_URL,

		/**
		 * Firestore database for auth state (users, sessions, accounts).
		 *
		 * Reuses the app's existing Firestore singleton — same project, same
		 * credentials. Collections are prefixed with `auth_` to namespace them
		 * away from the app's `users/{userId}` collection hierarchy.
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
			 * the cache entirely — they read `auth_users` directly — so cached
			 * role staleness is a display-only concern, not a security one.
			 */
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5, // 5 minutes
				strategy: "compact",
			},
		},

		socialProviders: {
			google: {
				clientId: process.env.GOOGLE_CLIENT_ID ?? "",
				clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
			},
		},

		/**
		 * Better Auth admin plugin — adds `role` to the auth user schema,
		 * plus banning, impersonation, and user management APIs.
		 *
		 * `role` lives on `auth_users` (Better Auth's user table) and is
		 * available as `session.user.role`. No custom session field needed.
		 *
		 * `adminUserIds` bootstraps admin access from an env var so the first
		 * admin doesn't need to manually edit Firestore. Users in this list
		 * are always treated as admin regardless of their `role` field.
		 */
		plugins: [
			admin({
				adminUserIds:
					process.env.ADMIN_USER_IDS?.split(",").filter(Boolean) ?? [],
			}),
		],

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

		/**
		 * Database lifecycle hooks for user provisioning.
		 *
		 * The app's `users/{userId}` doc is the foundation of the user's
		 * experience — activity tracking, admin dashboard, usage queries all
		 * depend on it. Two hooks guarantee it exists before the user can
		 * interact with the app:
		 *
		 * 1. `user.create.after` — creates the user doc on first sign-in.
		 *    Receives the full auth user object (id, email, name, image).
		 *
		 * 2. `session.create.before` — verifies the user doc exists before
		 *    every session is created. If it's missing (Firestore was down
		 *    during user.create.after, or the doc was manually deleted),
		 *    throws to abort the sign-in. The user can't end up
		 *    with a valid session but no user doc.
		 */
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						await createUserDoc(
							user.id,
							user.email,
							user.name,
							user.image ?? null,
						);
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						await ensureUserDoc(session.userId);
					},
				},
			},
		},
	});
}

/** Full auth instance type — used by the client's `inferAdditionalFields` plugin. */
export type Auth = ReturnType<typeof createAuth>;

/** Cached singleton — populated on first `getAuth()` call. */
let _auth: Auth | null = null;

/**
 * Returns the Better Auth singleton, initializing it on first call.
 *
 * Every call site that needs auth (route handlers, RSC auth checks) goes
 * through this function. The initialization is deferred so `next build`
 * can import this module without triggering Firestore connections or
 * missing-secret warnings.
 */
export function getAuth(): Auth {
	if (!_auth) _auth = createAuth();
	return _auth;
}

/** Type-safe session type derived from the auth config. */
export type Session = Auth["$Infer"]["Session"];
