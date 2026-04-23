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
import { HOSTNAMES } from "./hostnames";

/**
 * OAuth scopes Nova's authorization server can grant.
 *
 * Referenced twice in the oauth-provider config below:
 *   - `scopes` — the authoritative list the AS advertises + enforces.
 *   - `clientRegistrationDefaultScopes` — what a newly registered client
 *     gets when it doesn't send an explicit `scope` param during DCR.
 *
 * Both slots receive the same list because a client omitting `scope` on
 * registration is signalling "give me everything you can grant"; narrowing
 * the default would silently break clients that later request the full
 * set at /authorize. Tool-level scope enforcement still happens at the
 * MCP handler, so granting the full set here is safe.
 *
 * The OIDC trio (`openid`, `profile`, `email`) + `offline_access` is the
 * standard set clients expect for refresh-token flows. `nova.read` /
 * `nova.write` are Nova-specific scopes enforced per-tool.
 */
const NOVA_OAUTH_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"nova.read",
	"nova.write",
] as const;

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
		 * Disable the jwt plugin's `/token` endpoint.
		 *
		 * The `jwt()` plugin below mounts two endpoints: `/jwks` (public
		 * key set, which we keep) and `/token`, which mints a JWT scoped
		 * to the current session cookie. That's a second JWT-issuing
		 * surface alongside `/oauth2/token` (OAuth 2.1 authorization code
		 * exchange) — different credential lifecycle, different audience,
		 * different intended relying parties.
		 *
		 * Exposing both is non-compliant for OIDC/MCP: discovery documents
		 * advertise a single token endpoint, and clients seeing two
		 * JWT-minting paths can legitimately pick the wrong one. Nova
		 * only issues programmatic tokens through the OAuth code flow, so
		 * the jwt plugin's `/token` has no role and is stripped. The
		 * plugin stays enabled for its JWKS endpoint, which is exactly
		 * what `oauth-provider` needs to publish its signing keys.
		 *
		 * Per Better Auth's own jwt + oidc-provider docs, this pairing
		 * (disabled `/token` + `jwt({ disableSettingJwtHeader: true })`)
		 * is the mandatory configuration for OAuth/OIDC/MCP deployments.
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
					type: "date",
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
		 * Better Auth auto-trusts the configured `baseURL` origin, so this
		 * list is technically redundant when BETTER_AUTH_URL is set — and
		 * a no-op when it isn't. We list it explicitly for two reasons:
		 *   1. Visibility — the set of origins allowed to post to auth
		 *      endpoints is grep-able in this file, not buried in framework
		 *      inference.
		 *   2. Easy extension — preview / staging / custom domains get
		 *      appended here rather than requiring a config-shape refactor.
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
			 *   - `loginPage` / `consentPage` point at Nova-owned UI routes
			 *     so the OAuth flow reuses Nova's branded sign-in + a custom
			 *     consent screen rather than the plugin's minimal defaults.
			 *   - `validAudiences` pins the token `aud` claim to the MCP
			 *     resource URL. Tokens minted for Nova cannot be replayed
			 *     against any other audience.
			 *   - Dynamic client registration is enabled AND unauthenticated
			 *     so Claude Code (which has no pre-shared credentials) can
			 *     bootstrap itself. Abuse is bounded by the plugin's own
			 *     per-IP-per-endpoint rate limiter (see `rateLimit` below)
			 *     and by the 30-day client-secret expiration that forces
			 *     periodic re-registration.
			 *
			 * Rate limiting: `@better-auth/oauth-provider` ships its own
			 * per-endpoint limiter (distinct from Better Auth's global
			 * `rateLimit` above) with sensible production defaults. We
			 * override `register` specifically because it's the one public,
			 * unauthenticated endpoint that persists a Firestore doc on
			 * success — tightening it to 5 req/min per IP caps storage
			 * abuse without impacting legitimate clients (which register
			 * once per install). Other endpoints stay on plugin defaults.
			 */
			oauthProvider({
				/* Nova's sign-in surface is the root route — `/` renders the
				 * landing page with the Google OAuth button when no session
				 * exists (see CLAUDE.md's "no redirects" root-route design).
				 * There is no `/sign-in` page, so pointing the plugin there
				 * would 404 first-touch unauthenticated OAuth-flow users. */
				loginPage: "/",
				consentPage: "/consent",
				validAudiences: [`https://${HOSTNAMES.mcp}`],
				scopes: [...NOVA_OAUTH_SCOPES],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: [...NOVA_OAUTH_SCOPES],
				clientRegistrationClientSecretExpiration: "30d",
				rateLimit: {
					register: { window: 60, max: 5 },
				},
				/* `@better-auth/oauth-provider` nags on every cold start
				 * asking us to ensure the RFC 8414 metadata document is
				 * mounted, because its startup check fires unconditionally
				 * whenever `basePath !== "/"` — it can't HEAD-probe its own
				 * process to verify the route is actually there. The
				 * warning's own text tells you to silence it once you've
				 * verified the mount ("Upon completion, clear with
				 * silenceWarnings.oauthAuthServerConfig").
				 *
				 * We serve the metadata at
				 * `app/.well-known/oauth-authorization-server/route.ts`
				 * on the main host (`proxy.ts` allowlists the path there).
				 * Tokens are signed with `iss` defaulting to
				 * `ctx.options.baseURL` — i.e. `BETTER_AUTH_URL` — which is
				 * path-free, so spec-compliant clients probe the bare
				 * `/.well-known/oauth-authorization-server` (exactly what
				 * we serve). The warning text nominally points at a
				 * path-inserted variant under `/api/auth` based on the
				 * plugin's internal `ctx.baseURL` (which has `basePath`
				 * appended), but no real client probes that path given
				 * the actual signed `iss`. Silencing is the ack. */
				silenceWarnings: { oauthAuthServerConfig: true },
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
