/**
 * Better Auth — server-side authentication singleton.
 *
 * Initialized lazily via `getAuth()` so the Firestore adapter and env var
 * reads happen on the first real request, not at import time. This matters
 * because `next build` imports server modules during page collection —
 * module-level initialization would try to connect to Firestore and read
 * secrets that don't exist in the build environment.
 *
 * `auth_users` is the single source of truth for user identity. The app
 * extends it with `lastActiveAt` via `additionalFields` — no separate
 * user collection. Auth state lives in `auth_users`, `auth_sessions`,
 * `auth_accounts`, and `auth_verifications`.
 *
 * Required env vars (at runtime, not build time):
 *   BETTER_AUTH_SECRET   — cookie signing secret (generate with `openssl rand -base64 32`)
 *   GOOGLE_CLIENT_ID     — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL      — Base URL (e.g. http://localhost:3000 or production URL).
 *                          Optional in dev — Better Auth auto-detects from requests.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { admin, jwt } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "./db/firestore";

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
		 * Disable Better Auth's built-in `/token` endpoint.
		 *
		 * The `@better-auth/oauth-provider` plugin serves its own
		 * `/oauth2/token` endpoint, but Better Auth core also exposes a
		 * legacy `/token` path that overlaps semantically. When both are
		 * mounted, requests to the OAuth token endpoint can resolve to the
		 * wrong handler and fail CSRF / content-type validation. Better
		 * Auth's own docs list this as MANDATORY when running in
		 * OAuth / OIDC / MCP mode, so we strip the legacy path unconditionally.
		 */
		disabledPaths: ["/token"],

		/**
		 * Extend the auth user model with app-level fields.
		 *
		 * `lastActiveAt` — most recent authenticated interaction. Updated
		 * fire-and-forget on every request by `touchUser()` in auth-utils.ts.
		 * `required: false` because pre-migration users lack this field.
		 */
		user: {
			additionalFields: {
				lastActiveAt: {
					type: "date" as const,
					required: false,
					input: false,
					returned: true,
				},
			},
		},

		/**
		 * Firestore database for auth state (users, sessions, accounts).
		 *
		 * Reuses the app's existing Firestore singleton — same project, same
		 * credentials. Collections are prefixed with `auth_` to namespace them
		 * away from application data collections (apps, usage, etc.).
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
		 * Better Auth plugin stack.
		 *
		 * Three concerns are layered here:
		 *   1. `admin` — role + user-management APIs for the Nova admin dashboard.
		 *   2. `jwt`  — exposes `/api/auth/jwks` so OAuth access tokens (signed
		 *               by the oauth-provider plugin) can be verified by the
		 *               MCP handler and any other relying party.
		 *   3. `oauthProvider` — turns Better Auth into a full OAuth 2.1
		 *               authorization server for programmatic MCP clients.
		 *
		 * The session-cookie login flow on commcare.app is unaffected — the
		 * OAuth plugin only adds NEW endpoints under `/api/auth` and
		 * `/oauth2`, plus `.well-known` metadata. Nothing about existing
		 * first-party auth changes.
		 */
		plugins: [
			/**
			 * Admin plugin — adds `role` to the auth user schema, plus
			 * banning, impersonation, and user management APIs.
			 *
			 * `role` lives on `auth_users` (Better Auth's user table) and is
			 * available as `session.user.role`. No custom session field needed.
			 *
			 * `adminUserIds` bootstraps admin access from an env var so the
			 * first admin doesn't need to manually edit Firestore. Users in
			 * this list are always treated as admin regardless of their
			 * `role` field.
			 */
			admin({
				adminUserIds:
					process.env.ADMIN_USER_IDS?.split(",").filter(Boolean) ?? [],
			}),

			/**
			 * JWT plugin — exposes `/api/auth/jwks`. The oauth-provider
			 * plugin signs access tokens with these keys; the MCP handler
			 * verifies bearer tokens against the same JWKS. One keypair,
			 * one verification surface — no shared secrets to rotate.
			 *
			 * `disableSettingJwtHeader: true` is REQUIRED when running in
			 * OAuth / OIDC / MCP mode per Better Auth's docs. Without it,
			 * the JWT middleware attempts to attach bearer tokens to every
			 * Better Auth response, which conflicts with the session-cookie
			 * flow that the rest of Nova still uses for first-party login.
			 */
			jwt({ disableSettingJwtHeader: true }),

			/**
			 * OAuth 2.1 authorization server (`@better-auth/oauth-provider`).
			 *
			 * Turns Better Auth into a full OAuth-AS for programmatic clients
			 * — primarily Claude Code and any other MCP consumer, but the
			 * configuration is generic so additional clients can register
			 * dynamically (RFC 7591) without code changes.
			 *
			 * Notable choices:
			 *   - `loginPage` / `consentPage` point at Nova's own UI routes
			 *     so the OAuth flow reuses Nova's branded sign-in + a custom
			 *     consent screen (built in Phase B4/B5) rather than the
			 *     plugin's minimal defaults.
			 *   - `validAudiences` pins the token `aud` claim to the MCP
			 *     resource URL. Tokens minted for Nova cannot be replayed
			 *     against any other audience.
			 *   - `scopes` + `clientRegistrationDefaultScopes` both list the
			 *     same set. `nova.read` / `nova.write` are Nova-specific
			 *     scopes enforced by MCP tool handlers; the OIDC trio plus
			 *     `offline_access` covers the standard set clients expect
			 *     when requesting refresh tokens.
			 *   - Dynamic client registration is enabled AND unauthenticated
			 *     so Claude Code (which has no pre-shared credentials) can
			 *     bootstrap itself. Abuse is bounded by the plugin's built-in
			 *     per-endpoint rate limiting (kept at defaults — the only
			 *     rate-limiting surface this feature introduces) and by the
			 *     30-day client-secret expiration that forces periodic
			 *     re-registration.
			 */
			oauthProvider({
				loginPage: "/sign-in",
				consentPage: "/consent",
				validAudiences: ["https://mcp.commcare.app"],
				scopes: [
					"openid",
					"profile",
					"email",
					"offline_access",
					"nova.read",
					"nova.write",
				],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: [
					"openid",
					"profile",
					"email",
					"offline_access",
					"nova.read",
					"nova.write",
				],
				clientRegistrationClientSecretExpiration: "30d",
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
