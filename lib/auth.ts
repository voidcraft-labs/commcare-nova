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
 *   BETTER_AUTH_SECRET   — cookie signing secret (generate with `openssl rand -hex 32`)
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

	session: {
		expiresIn: 60 * 60 * 24 * 2, // 2 days max lifetime
		updateAge: 60 * 60 * 12, // refresh every 12h of activity

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
			clientId: process.env.GOOGLE_CLIENT_ID!,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
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
		 *    via `auth.api.updateSession`. Promotions happen via the Firestore
		 *    console (setting `role` to 'admin') — the next sign-in picks it up.
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

			await auth.api.updateSession({
				headers: ctx.headers,
				body: { isAdmin },
			});
		}),
	},
});

/** Type-safe session type exported for use in route handlers. */
export type Session = typeof auth.$Infer.Session;
