/**
 * Better Auth — server-side authentication singleton.
 *
 * Initialized lazily via `getAuth()` (async) so the Postgres pool and env var
 * reads happen on the first real request, not at import time. `getAuth()` is
 * async because the shared Cloud SQL pool is resolved asynchronously (the
 * connector's `getOptions`); this also keeps `next build` page collection from
 * opening a database connection or reading secrets that don't exist at build.
 *
 * `auth_user` is the single source of truth for user identity. The app extends
 * it with `lastActiveAt` via `additionalFields` — no separate user table. Auth
 * state lives in Postgres, every table `auth_`-prefixed via per-model
 * `modelName` (see the model + plugin config below): `auth_user`,
 * `auth_session`, `auth_account`, `auth_verification`, `auth_rate_limit`,
 * `auth_apikey`, `auth_jwks`, and the `auth_oauth_{client,consent,refresh_token}`
 * trio. Better Auth runs its own Kysely on the case-store's shared `pg.Pool`
 * (`getCaseStorePool`) so the connection budget stays at one pool per instance.
 *
 * Required env vars (at runtime, not build time):
 *   BETTER_AUTH_SECRET   — cookie signing secret (generate with `openssl rand -base64 32`)
 *   GOOGLE_CLIENT_ID     — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL      — Base URL (e.g. http://localhost:3000 or production URL).
 *                          Optional in dev — Better Auth auto-detects from requests.
 */
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, jwt, organization } from "better-auth/plugins";
import { novaMcpPlugin } from "@/app/api/mcp/auth-plugin";
// Custom "Projects" roles + access control, shared with the client config.
import { ac, MEMBERSHIP_LIMIT, PROJECT_ROLES } from "./auth/projectRoles";
import { ensurePersonalProject } from "./auth/provisionProject";
import { SIGN_IN_ERROR } from "./auth-errors";
import { forwardBetterAuthLog } from "./auth-logger";
import { NOVA_API_KEY_PREFIX, NOVA_API_KEY_SCOPES } from "./auth-public";
// Shared `auth_`-prefixed table names — single-sourced so the runtime config
// here and the migrator (`lib/auth-migrate-options.ts`) can't diverge.
import { AUTH_TABLE_NAMES, ORGANIZATION_SCHEMA } from "./auth-schema-shared";
// The shared Cloud SQL pool. Better Auth runs its own Kysely on this ONE pool
// (not a second) so the per-instance connection budget holds — see
// `lib/case-store/postgres/connection.ts::enforceConnectionBudget`.
import { getCaseStorePool } from "./case-store/postgres/connection";
import { MCP_RESOURCE_URL } from "./hostnames";
import { log } from "./logger";
import {
	INVITE_ALLOWED_DOMAINS,
	isInvitableEmail,
	isPersonalProjectMetadata,
	PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
} from "./projects/invitePolicy";

/**
 * OAuth scopes Nova's authorization server can grant.
 *
 * Referenced three times in the oauth-provider config below:
 *   - `scopes` — the authoritative list the AS advertises + enforces.
 *   - `clientRegistrationDefaultScopes` — what a newly registered client
 *     gets when it doesn't send an explicit `scope` param during DCR.
 *   - `clientRegistrationAllowedScopes` — the complete allowlist a dynamic
 *     client may request explicitly.
 *
 * Defaults deliberately exclude HQ scopes. A public DCR client omitting
 * `scope` should get the MCP baseline, not delegated CommCare HQ powers.
 * HQ scopes stay requestable via `clientRegistrationAllowedScopes`, so a
 * client that needs deployment can ask for them explicitly and the consent
 * screen can make that grant visible. Better Auth treats the registration
 * allowlist as the full valid set, so it includes the baseline scopes too.
 *
 * The OIDC trio (`openid`, `profile`, `email`) + `offline_access` is the
 * standard set clients expect for refresh-token flows. The Nova scopes
 * split into two layers: `nova.read` / `nova.write` cover Nova-internal
 * (Firestore-backed) operations and are enforced at the MCP route's
 * verify layer; `nova.hq.read` / `nova.hq.write` cover delegated access
 * to CommCare HQ via the user's stored API key and are enforced
 * per-tool inside the HQ handlers (see `lib/mcp/scopes.ts`'s
 * `assertScope`). HQ access is *orthogonal* to read/write — a client
 * that only needs Nova-internal access can omit the HQ scopes at
 * `/oauth2/authorize` and still call non-HQ tools.
 */
const NOVA_OAUTH_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"nova.read",
	"nova.write",
	"nova.hq.read",
	"nova.hq.write",
] as const;

export const NOVA_OAUTH_DEFAULT_CLIENT_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"nova.read",
	"nova.write",
] as const;

export const NOVA_OAUTH_ALLOWED_CLIENT_SCOPES = [
	...NOVA_OAUTH_DEFAULT_CLIENT_SCOPES,
	"nova.hq.read",
	"nova.hq.write",
] as const;

/**
 * Public API-key constants live in `lib/auth-public.ts` so client
 * components can import them without pulling Better Auth's server-only
 * graph (firebase-admin, etc.) into the browser bundle. Re-exported
 * here so server code already importing `@/lib/auth` doesn't have to
 * change.
 */
export { NOVA_API_KEY_PREFIX, NOVA_API_KEY_SCOPES };

/**
 * Email-domain allowlist for first-party sign-in.
 *
 * The set of company domains Nova accepts during OAuth user creation.
 * Hardcoded as a code constant rather than env-driven for two reasons:
 * this is the production access gate, so a typo in a deployment env var
 * would be a security failure; and adding or removing a domain is a
 * deliberate decision that warrants a code review, not an ops tweak.
 *
 * SINGLE-SOURCED from `INVITE_ALLOWED_DOMAINS` (`lib/projects/invitePolicy`):
 * sign-in and Project invitations gate on the SAME dimagi domains — an
 * invitee who couldn't sign in would be a dead invite — so the two security
 * allowlists can't drift. The values are lowercase so the comparison in
 * `databaseHooks` below can lowercase the incoming email and use a single
 * straight `Set.has` check (Google emails are case-preserving but
 * case-insensitive for matching).
 */
const ALLOWED_EMAIL_DOMAINS: ReadonlySet<string> = new Set(
	INVITE_ALLOWED_DOMAINS,
);

/**
 * Creates the Better Auth instance. Async because it acquires the shared
 * Cloud SQL pool. Named (not inlined) so `Awaited<ReturnType<typeof createAuth>>`
 * (the exported `Auth` type) captures the full config-specific instance type —
 * needed by the client's `inferAdditionalFields` plugin to pick up plugin-added
 * fields (admin plugin's `role` on user, etc.).
 */
async function createAuth() {
	// Better Auth runs its own Kysely on the case-store's shared `pg.Pool`; one
	// pool per instance keeps the connection budget intact. Passing a `pg.Pool`
	// lets Better Auth detect the Postgres dialect itself.
	const pool = await getCaseStorePool();

	return betterAuth({
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL: process.env.BETTER_AUTH_URL,

		/**
		 * Route Better Auth's internal logger through Nova's logger so auth
		 * errors reach Sentry. Better Auth catches `/api/auth/*` failures inside
		 * its router and logs them via this handler instead of throwing, so
		 * without the bridge neither Sentry's auto-instrumentation nor Nova's
		 * `log.error` mirror ever sees them — the whole auth surface is a Sentry
		 * blind spot. See `lib/auth-logger.ts` for the level mapping.
		 */
		logger: {
			log: (level, message, ...args) =>
				forwardBetterAuthLog(level, message, args),
		},

		/**
		 * Block HTTP routes Better Auth would otherwise auto-mount from
		 * its plugins. `disabledPaths` checks at the HTTP `onRequest`
		 * boundary; the `auth.api.*` typed surface bypasses it, so
		 * server-side calls (the MCP route's `verifyApiKey`, the Server
		 * Actions' `createApiKey` / `updateApiKey` / `deleteApiKey`)
		 * keep working unaffected.
		 *
		 * **`/token`** — the `jwt()` plugin mounts `/jwks` (public key
		 * set, which Nova needs) and `/token` (mints a JWT from the
		 * session cookie). The `/token` endpoint duplicates
		 * `/oauth2/token` with a different credential lifecycle and
		 * audience; OIDC/MCP discovery advertises a single token
		 * endpoint, and clients seeing two JWT-minting paths legitimately
		 * pick the wrong one. Per Better Auth's jwt + oidc-provider
		 * docs, the pairing (disabled `/token` plus
		 * `jwt({ disableSettingJwtHeader: true })`) is mandatory for
		 * OAuth/OIDC/MCP deployments.
		 *
		 * **`/api-key/*`** — the api-key plugin auto-mounts five CRUD
		 * endpoints (`create`, `delete`, `update`, `list`, `get`) under
		 * `/api/auth/api-key/*`. The Settings UI Server Actions are the
		 * only intended authoring surface; they enforce the per-user
		 * limit, scope vocabulary, floor scopes, and audit logging.
		 * Leaving the HTTP endpoints live exposes a parallel surface
		 * that bypasses every one of those — the per-user cap stops
		 * being a cap, mints go unaudited, and `list` exposes a second
		 * read path. Disabling them keeps the Server Actions as the
		 * sole authoring surface; the MCP route's
		 * `auth.api.verifyApiKey` is a typed call and stays unaffected.
		 *
		 * Two of the plugin's other endpoints (`verify`,
		 * `delete-all-expired-api-keys`) are declared without a path
		 * string and so aren't HTTP-mounted at all — they exist only
		 * on the `auth.api.*` typed surface. They don't need to be in
		 * `disabledPaths`; listing them would be a no-op (better-call's
		 * router skips entries with no `path`).
		 */
		disabledPaths: [
			"/token",
			"/api-key/create",
			"/api-key/delete",
			"/api-key/update",
			"/api-key/list",
			"/api-key/get",
			/* Organization endpoints are permission-gated by the access-control
			 * roles (`lib/auth/projectRoles.ts`); invitations are additionally
			 * domain-gated by the `beforeCreateInvitation` hook. */
		],

		/**
		 * Extend the auth user model with app-level fields.
		 *
		 * `lastActiveAt` — most recent authenticated interaction. Updated
		 * fire-and-forget on every request by `touchUser()` in auth-utils.ts.
		 * `required: false` because pre-migration users lack this field.
		 */
		user: {
			modelName: AUTH_TABLE_NAMES.user,
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
		 * Postgres for all auth state via Better Auth's built-in Kysely adapter.
		 * Better Auth runs its OWN Kysely on the case-store's shared `pg.Pool`
		 * (passing a `pg.Pool` lets it detect the Postgres dialect itself); one
		 * pool per instance keeps the connection budget intact. The atomic
		 * rate-limiter counter (`incrementOne`) and OAuth single-use token
		 * consumption (`consumeOne`) are native to this adapter.
		 *
		 * Every model's table is `auth_`-prefixed via per-model `modelName` (here
		 * for the core models + each plugin's `schema` below), so the whole schema
		 * is namespaced.
		 */
		database: pool,

		verification: { modelName: AUTH_TABLE_NAMES.verification },

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
		 * Postgres so all instances share the same rate limit state. Custom
		 * rules tighten sensitive auth endpoints beyond the 100 req/10s default.
		 */
		rateLimit: {
			storage: "database",
			modelName: AUTH_TABLE_NAMES.rateLimit,
			customRules: {
				"/api/auth/callback/:path": { window: 60, max: 10 },
				/* Per-IP cap on the MCP route. The rule key is the path
				 * after Better Auth strips its `/api/auth` basePath
				 * (`normalizePathname` in
				 * `node_modules/@better-auth/core/dist/utils/url.mjs`),
				 * so `/api/auth/mcp` matches the literal `/mcp`.
				 *
				 * Picked to absorb realistic agent-driven traffic without
				 * letting an unauthenticated attacker hammer the
				 * Postgres-backed `verifyApiKey` lookup or the JWT
				 * verifier. 120 req/min ≈ 2 per second, comfortably
				 * above tool-call cadence even from concurrent worktrees
				 * (each worktree gets its own per-IP counter).
				 *
				 * Important: this is a SUSTAINED-rate cap, not an
				 * atomic concurrency bound. Better Auth checks the
				 * counter in `onRequest` and increments it in
				 * `onResponse`, so a cold/reset IP can fire through
				 * up to Cloud Run's per-instance request concurrency
				 * (default 80) before any response-side increment
				 * lands. Each burst request still hits `verifyApiKey`
				 * and the Postgres lookup. The rate limiter starts
				 * blocking on the next sustained window, so over time
				 * the cap holds — but it does not protect against
				 * single-burst abuse. Edge-level rate limiting (Cloud
				 * Armor on the Cloud Run load balancer, or whatever
				 * fronts the service in your deployment) is the right
				 * tool for the burst case; the in-app cap is the
				 * second line. */
				"/mcp": { window: 60, max: 120 },
			},
		},

		session: {
			modelName: AUTH_TABLE_NAMES.session,
			expiresIn: 60 * 60 * 24 * 2, // 2 days max lifetime
			updateAge: 60 * 60 * 12, // refresh every 12h of activity

			/**
			 * Session cookie cache — avoids the Better Auth session-row read on
			 * every request.
			 *
			 * Compact strategy (Base64url + HMAC) has the smallest cookie payload.
			 * 5-minute maxAge means the cached session payload is re-fetched from
			 * Postgres at most every 5 minutes. Admin checks (`requireAdminAccess`)
			 * bypass the cache entirely — they read `auth_user` directly — so
			 * cached role staleness is a display-only concern, not a security one.
			 *
			 * Account REVOCATION (ban / delete) does NOT ride this cache: the two
			 * session choke points (`auth-utils.ts::{getSessionSafe,getSession}`)
			 * run a live `isUserActive` read on every authenticated request, so a
			 * banned or deleted user is denied within the window rather than after
			 * it. The cache still spares the session-row read; the live check is a
			 * separate `auth_user` read.
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
		 * Global redirect target for API errors that bubble out of the
		 * Better Auth router without a per-call `errorCallbackURL`.
		 *
		 * The OAuth callback redirector reads each request's
		 * `errorCallbackURL` from state (set by the client's
		 * `signIn.social({ errorCallbackURL: "/" })` call), and falls
		 * back to this global URL when state is missing or the per-call
		 * URL is dropped — see Better Auth issues #5518/#4694/#1580 for
		 * known paths where the per-call URL is silently ignored.
		 *
		 * The default is `${baseURL}/error`, which Nova does not own;
		 * pointing it at `/` keeps every error redirect on the landing
		 * page (which knows how to surface `?error=…`) rather than
		 * 404-ing through to a route that does not exist.
		 */
		onAPIError: {
			errorURL: "/",
		},

		/**
		 * Email-domain gate for OAuth sign-in.
		 *
		 * Better Auth's `databaseHooks.user.create.before` fires inside
		 * the OAuth callback handler — after Google's tokens have been
		 * verified and userinfo fetched, but BEFORE the `auth_user` row
		 * is written, the `auth_account` link is created, or any session
		 * is established. Throwing `APIError` aborts the entire callback
		 * chain, so a rejected user leaves no database trace and never
		 * receives a session cookie. There is no in-between window where
		 * a non-allowlisted user is partially signed in.
		 *
		 * The hook only fires on user creation, not on subsequent
		 * sign-ins of an existing account. That is deliberate: the
		 * allowlist polices who can be ADMITTED. Once an account
		 * exists in `auth_user`, ban/role-based revocation is the
		 * mechanism for removing access (handled by the admin plugin).
		 *
		 * Domain extraction takes the substring after the LAST `@`,
		 * which is the correct boundary for any RFC-shaped email and
		 * defuses degenerate inputs like quoted local-parts. Casing is
		 * normalized to lowercase before the allowlist check (see the
		 * comment on `ALLOWED_EMAIL_DOMAINS`).
		 *
		 * This hook is the single source of truth for the sign-in
		 * domain policy. The OAuth consent screen at the GCP level may
		 * narrow the set further (an Internal-mode screen rejects
		 * non-Workspace users before they ever reach this code), but
		 * Nova's own gate must independently enforce the allowlist
		 * regardless of the consent-screen configuration.
		 *
		 * The hook applies to every user-creation path on the adapter,
		 * including the admin plugin's `/admin/create-user` endpoint —
		 * an admin cannot seat a user with an out-of-allowlist email.
		 * That is intentional: admin tooling here manages users who
		 * have already arrived through OAuth, not external invitees.
		 * If invite-by-admin for non-Dimagi addresses is ever needed,
		 * `ctx.path === "/admin/create-user"` is the discriminator that
		 * would let that path bypass the gate.
		 */
		databaseHooks: {
			user: {
				create: {
					before: async (user, _ctx) => {
						const domain = user.email?.toLowerCase().split("@").at(-1);
						if (!domain || !ALLOWED_EMAIL_DOMAINS.has(domain)) {
							/* Audit trail for the access gate. Logged at WARNING so a
							 * misconfigured allowlist (typo, missing domain) shows up
							 * in Cloud Logging without being lost in INFO noise.
							 * Email is included because Cloud Logging is access-controlled
							 * and this is the only persistent record of a rejected
							 * attempt — without it, diagnosing a locked-out legitimate
							 * user means reconstructing the redirect URL from screenshots. */
							log.warn(
								"[auth] Sign-in rejected: email domain not in allowlist",
								{
									email: user.email ?? "(missing)",
									domain: domain ?? "(none)",
								},
							);
							/* The `message` here is the URL-safe code from
							 * `lib/auth-errors.ts`, not a user-facing sentence —
							 * Better Auth puts this string into the redirect URL,
							 * and the landing page maps the code back to prose
							 * after importing the same constant. Keeping the prose
							 * out of this file keeps producer and consumer linked
							 * by a single typed value. */
							throw new APIError("FORBIDDEN", {
								message: SIGN_IN_ERROR.domainRejected,
							});
						}
						return { data: user };
					},
				},
			},
			/**
			 * Stamp the user's active Project on every new session.
			 *
			 * Provisions the personal Project on first sign-in (idempotent) and
			 * sets `activeOrganizationId` so the very first session already has a
			 * tenancy scope. Wrapped so a provisioning failure NEVER blocks
			 * sign-in — throwing here would abort session creation and lock the
			 * user out; on failure we log and leave the session unstamped, and the
			 * read-path fallback self-heals on a later request.
			 */
			session: {
				create: {
					before: async (session) => {
						try {
							const activeOrganizationId = await ensurePersonalProject(
								session.userId,
							);
							return { data: { ...session, activeOrganizationId } };
						} catch (err) {
							log.error(
								"[auth] personal-Project provisioning failed at session create",
								err,
								{ userId: session.userId },
							);
							return;
						}
					},
				},
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
			 * `role` lives on `auth_user` (Better Auth's user table) and is
			 * available as `session.user.role`. No custom session field needed.
			 *
			 * `adminUserIds` bootstraps admin access from an env var so the
			 * first admin doesn't need to manually edit the database. Users in
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
			jwt({
				disableSettingJwtHeader: true,
				// `auth_`-prefix the JWKS table, like every other auth model.
				schema: { jwks: { modelName: AUTH_TABLE_NAMES.jwks } },
			}),

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
			 *     and by opportunistic cleanup of stale unauthenticated
			 *     public clients on successful registration. Public clients
			 *     do not receive a client secret, so secret expiration
			 *     cannot bound this storage surface.
			 *
			 * Rate limiting: `@better-auth/oauth-provider` ships its own
			 * per-endpoint limiter (distinct from Better Auth's global
			 * `rateLimit` above) with sensible production defaults. We
			 * override `register` specifically because it's the one public,
			 * unauthenticated endpoint that persists a row on
			 * success — tightening it to 5 req/min per IP caps storage
			 * abuse without impacting legitimate clients (which register
			 * once per install). Other endpoints stay on plugin defaults.
			 */
			oauthProvider({
				/* Nova's sign-in surface is the root route — `/` branches
				 * between landing / get-started / app list with no
				 * redirects, rendering the Google OAuth button when no
				 * session exists. There is no `/sign-in` page, so pointing
				 * the plugin there would 404 first-touch unauthenticated
				 * OAuth-flow users. */
				loginPage: "/",
				consentPage: "/consent",
				validAudiences: [MCP_RESOURCE_URL],
				scopes: [...NOVA_OAUTH_SCOPES],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: [...NOVA_OAUTH_DEFAULT_CLIENT_SCOPES],
				clientRegistrationAllowedScopes: [...NOVA_OAUTH_ALLOWED_CLIENT_SCOPES],
				clientRegistrationClientSecretExpiration: "30d",
				rateLimit: {
					register: { window: 60, max: 5 },
				},
				/* RFC 8414 metadata is mounted at
				 * `app/.well-known/oauth-authorization-server/route.ts`
				 * on the main host (`proxy.ts` allowlists the path there).
				 * The plugin's startup check fires whenever
				 * `basePath !== "/"` — it can't HEAD-probe its own process
				 * to confirm the route is mounted, so it nags
				 * unconditionally. Silencing is the ack per the plugin's
				 * own guidance ("Upon completion, clear with
				 * silenceWarnings.oauthAuthServerConfig"). */
				silenceWarnings: { oauthAuthServerConfig: true },
				// `auth_`-prefix EVERY oauth-provider table — including
				// `oauthAccessToken`, which (like the old `verification` wart) lands
				// unprefixed if omitted. The app-owned reads in
				// `lib/db/oauth-consents.ts` query the client/consent/refresh names.
				schema: {
					oauthClient: { modelName: AUTH_TABLE_NAMES.oauthClient },
					oauthConsent: { modelName: AUTH_TABLE_NAMES.oauthConsent },
					oauthRefreshToken: {
						modelName: AUTH_TABLE_NAMES.oauthRefreshToken,
					},
					oauthAccessToken: { modelName: AUTH_TABLE_NAMES.oauthAccessToken },
				},
			}),

			/**
			 * API Key plugin — long-lived bearer credentials for
			 * non-interactive MCP consumers (ACE-style automation running
			 * across many concurrent worktrees with one shared service
			 * identity).
			 *
			 * The MCP route dispatcher in `app/api/mcp/auth-plugin.ts`
			 * (`dispatchMcpAuthRequest`) peeks the `Authorization` header
			 * for `NOVA_API_KEY_PREFIX` and forks to the api-key verify
			 * path for matching tokens; everything else goes through the
			 * JWT (OAuth-issued) path. Browser users on commcare.app sign
			 * in with Google, and `enableSessionForAPIKeys: false` keeps
			 * the api-key surface from minting cookie sessions, so the
			 * two paths can't bleed into each other.
			 *
			 * Why API keys are necessary alongside OAuth:
			 * `@better-auth/oauth-provider` rotates refresh tokens
			 * unconditionally (`createRefreshToken` writes
			 * `revoked: <Date>` to the prior row on every refresh), and
			 * there is no toggle to disable rotation. When two concurrent
			 * sessions share one credential file, the second session's
			 * stale refresh token triggers a cascade revocation that wipes
			 * every row for that `(userId, clientId)` pair — both sessions
			 * are forced back through interactive OAuth. That security
			 * posture is correct for human-using-Claude-Code-on-commcare.app
			 * but fights the service-identity-with-many-workers shape ACE
			 * has. API keys give that shape a credential model that matches
			 * its trust relationship.
			 *
			 * Configuration choices:
			 *   - `defaultPrefix` is the single source of truth for the wire
			 *     prefix. The MCP route's dispatcher reads `NOVA_API_KEY_PREFIX`
			 *     from this same module so they cannot drift.
			 *   - `defaultKeyLength: 32` is shorter than the plugin default
			 *     of 64 only because `sk-nova-v1-` already adds 11 visible
			 *     characters; the total wire token is 43 chars,
			 *     comfortably copy-pasteable while still
			 *     brute-force-infeasible against the 52-char a-zA-Z
			 *     alphabet the plugin uses.
			 *   - `startingCharactersConfig.charactersLength: 17` stores the
			 *     prefix (11 chars) plus 6 key chars in the `start` field. The
			 *     settings UI uses this for masked display
			 *     (`sk-nova-v1-aBc12X • • • …`) so users can identify a key
			 *     without revealing its full value.
			 *   - `requireName: true` because every key on the settings page
			 *     needs a human-readable label; an unnamed list is unmanageable.
			 *   - `enableMetadata: false` — Nova doesn't track metadata on
			 *     keys; turning it off keeps the create payload tighter and
			 *     the storage surface smaller.
			 *   - `keyExpiration.defaultExpiresIn: 1y` matches the
			 *     1-year-default decision baked into the settings UI's expiry
			 *     selector. Service identities want long-lived credentials;
			 *     tighter rotation is opt-in at mint time.
			 *   - `keyExpiration.maxExpiresIn: 36500` (~100 years) is the
			 *     escape hatch for the "Never expires" UI option. The plugin's
			 *     default cap of 365 days would block that path. 100 years is
			 *     functionally unbounded without leaving the configured ceiling
			 *     truly infinite — keeps the create endpoint's bounds-check
			 *     active for any future tightening.
			 *   - `enableSessionForAPIKeys: false` is the default but pinned
			 *     explicitly: API keys authenticate the MCP route only, never
			 *     a browser session on commcare.app.
			 *   - `references: "user"` is the default but pinned explicitly:
			 *     Nova's data model is single-user and there is no
			 *     `organization` table. Switching to `"organization"` would be
			 *     a schema change, not a config flip.
			 */
			apiKey({
				defaultPrefix: NOVA_API_KEY_PREFIX,
				defaultKeyLength: 32,
				startingCharactersConfig: {
					shouldStore: true,
					charactersLength: NOVA_API_KEY_PREFIX.length + 6,
				},
				requireName: true,
				enableMetadata: false,
				enableSessionForAPIKeys: false,
				storage: "database",
				/* Per-key rate limiting disabled. The plugin's
				 * `isRateLimited` is a "fixed window since last request"
				 * algorithm: the request counter resets to 1 whenever the
				 * gap between calls exceeds `timeWindow`, rather than a
				 * true sliding-window or fixed-window-from-mint cap. For a
				 * service identity making one request every <`timeWindow`>
				 * seconds, the limit never engages; for one running
				 * sub-`timeWindow` bursts then idle, each idle period
				 * resets the counter. Neither matches what "N requests per
				 * window" usually means.
				 *
				 * IP-based rate limiting on the MCP route is what bounds
				 * abuse. It runs at the Better Auth router layer
				 * (`onRequestRateLimit` in `node_modules/better-auth/dist/
				 * api/index.mjs`) for every routed request, including the
				 * plugin endpoint at `/api/auth/mcp` registered by
				 * `app/api/mcp/auth-plugin.ts::novaMcpPlugin`. The
				 * `customRules` rule for `/mcp` configured below sets the
				 * per-IP cap. Adding a per-key cap with misleading
				 * fixed-window-since-last-request semantics on top would
				 * suggest a second bound that doesn't behave like
				 * "requests per window". */
				rateLimit: { enabled: false },
				/* Move the plugin's per-verify `lastRequest` write off the
				 * auth hot path. Without this, every successful `verifyApiKey`
				 * awaits an UPDATE to the key's `auth_apikey` row before
				 * returning, so verify latency includes a write round-trip —
				 * concentrated on the shared-service-key case the feature
				 * targets (one key, many concurrent worktrees), where the same
				 * row is updated on every call. With `deferUpdates: true` the
				 * write fires via `runInBackground` after the verify response is
				 * built — auth doesn't wait and the "Last used" timestamp still
				 * updates. The tradeoff: a write failure degrades silently to
				 * logs without blocking the request, which is the right shape —
				 * losing an audit timestamp is preferable to denying
				 * authenticated service-account traffic. */
				deferUpdates: true,
				keyExpiration: {
					/* `defaultExpiresIn` is in SECONDS despite the plugin type
					 * docstring claiming milliseconds — the create endpoint
					 * runs `getDate(defaultExpiresIn, "sec")`, which the
					 * `getDate` helper interprets as seconds (multiplies by
					 * 1000 internally). `minExpiresIn` and `maxExpiresIn` are
					 * in DAYS (the create endpoint divides incoming
					 * `expiresIn` by 86400 before comparing). The mixed units
					 * inside one config block are confusing on a casual read;
					 * the source of truth is the plugin's `getDate(...)` and
					 * `expiresIn / (3600 * 24)` calls in
					 * `node_modules/@better-auth/api-key/dist/index.mjs`. */
					defaultExpiresIn: 365 * 24 * 60 * 60,
					minExpiresIn: 1,
					maxExpiresIn: 36500,
				},
				references: "user",
				// `auth_`-prefix the api-key table.
				schema: { apikey: { modelName: AUTH_TABLE_NAMES.apikey } },
			}),

			/**
			 * Organization plugin — Nova's "Projects" tenancy (shared app spaces).
			 *
			 * Surfaced to users as "Projects"; the tables stay `auth_organization*`
			 * (the persistence name is decoupled from the product noun — "project
			 * space" already means a CommCare HQ domain elsewhere). Custom roles
			 * (`viewer`/`editor`/`admin`/`owner` over an `app` resource) live in
			 * `lib/auth/projectRoles.ts` and are mirrored on the client
			 * (`lib/auth-client.ts`) so client-side permission checks match the
			 * server. Teams and dynamic access control stay OFF — flat Projects
			 * with static roles.
			 *
			 * The schema-only mirror in `lib/auth-migrate-options.ts` is what makes
			 * the migrate Job create `auth_organization` / `auth_member` /
			 * `auth_invitation` and add `auth_session.activeOrganizationId` — keep
			 * the two plugin registrations in sync.
			 *
			 * No invitation email is sent — invites are discovered in-app (the
			 * home-page banner + the Invitations page); `afterCreateInvitation`
			 * only records an audit line.
			 */
			organization({
				ac,
				roles: PROJECT_ROLES,
				creatorRole: "owner",
				allowUserToCreateOrganization: true,
				membershipLimit: MEMBERSHIP_LIMIT,
				teams: { enabled: false },
				schema: ORGANIZATION_SCHEMA,
				organizationHooks: {
					/* Domain-gate every invitation at creation: a Project may only
					 * invite dimagi addresses. This is the enforced control behind
					 * `isInvitableEmail` — belt-and-suspenders over the sign-in
					 * allowlist (a non-allowlisted invitee could never accept, but
					 * rejecting up front keeps the members UI + audit honest).
					 * Throwing an `APIError` aborts the create with a 400. */
					beforeCreateInvitation: async ({ invitation, organization }) => {
						if (!isInvitableEmail(invitation.email)) {
							throw new APIError("BAD_REQUEST", {
								message: `Invitations are limited to ${INVITE_ALLOWED_DOMAINS.join(" and ")} email addresses.`,
							});
						}
						/* A personal Project is private and accepts no invitations at
						 * all — collaboration happens by moving an app into a shared
						 * Project. The members UI renders a read-only "can't be shared"
						 * panel; this is the wire-level enforcement (a crafted request
						 * can't escape it). `organization.metadata` carries the personal
						 * flag (set by `ensurePersonalProject`). */
						if (isPersonalProjectMetadata(organization.metadata)) {
							throw new APIError("BAD_REQUEST", {
								message: PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
							});
						}
					},
					/* The role-change twin: a personal Project has only its owner, so
					 * there is no member to re-role. Reject any role change on one as a
					 * defensive guard (a crafted request can't reach a member it has). */
					beforeUpdateMemberRole: async ({ organization }) => {
						if (isPersonalProjectMetadata(organization.metadata)) {
							throw new APIError("BAD_REQUEST", {
								message: PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
							});
						}
					},
					/* No invitation email is sent — invites are discovered in-app (the
					 * home-page banner + the Invitations page). This hook only records
					 * an audit line as each invite is created. */
					afterCreateInvitation: async ({ invitation, organization }) => {
						log.info("[auth] organization invitation created", {
							organizationId: organization.id,
							email: invitation.email,
						});
					},
				},
			}),
			novaMcpPlugin(),
		],

		/**
		 * Encrypt OAuth access/refresh tokens at rest with AES-256-GCM.
		 *
		 * Even though we only use Google OAuth for sign-in (not API access on
		 * behalf of users), encrypting stored tokens is defense-in-depth — if
		 * the `auth_account` table is ever exposed, raw tokens can't be reused.
		 */
		account: {
			modelName: AUTH_TABLE_NAMES.account,
			encryptOAuthTokens: true,
		},

		/**
		 * IP tracking configuration.
		 *
		 * Better Auth reads the trusted client IP from the proxy-stamped
		 * `x-nova-client-ip` header rather than `X-Forwarded-For`
		 * directly. `proxy.ts` derives it from XFF's trusted suffix
		 * (rightmost N entries, where N matches the deployment's
		 * trusted-hops count) and strips any client-supplied value
		 * first, so the rate limiter and session tracker key on a
		 * non-spoofable IP. Reading XFF directly would let a client
		 * rotate the leftmost value (which Google Front End preserves
		 * through to the container) and evade per-IP enforcement.
		 *
		 * The single-header list is deliberate: with only this header,
		 * a request that bypassed `proxy.ts` (tests, dev paths,
		 * misconfiguration) yields `null` for the IP — Better Auth
		 * skips per-IP rate-limit attribution rather than silently
		 * falling back to a spoofable header. Fail-loud is the right
		 * posture; "soft fallback to XFF" would re-introduce the
		 * spoofing surface for any path that doesn't run the proxy.
		 */
		advanced: {
			ipAddress: {
				ipAddressHeaders: ["x-nova-client-ip"],
			},
		},
	});
}

/**
 * Full auth instance type — used by the client's `inferAdditionalFields`
 * plugin. `createAuth` is async (it awaits the shared pool), so unwrap the
 * promise to recover the instance type.
 */
export type Auth = Awaited<ReturnType<typeof createAuth>>;

/** Cached singleton — populated on first successful `getAuth()` call. */
let _auth: Auth | null = null;
/** Concurrent first-callers share one init rather than racing. */
let _authInFlight: Promise<Auth> | null = null;

/**
 * Returns the Better Auth singleton, initializing it on first call.
 *
 * Async because the shared Cloud SQL pool is resolved asynchronously. Every
 * call site that needs auth (route handlers, RSC auth checks) awaits this. The
 * initialization is deferred so `next build` can import this module without
 * opening a database connection or hitting missing-secret warnings. Mirrors the
 * case-store's `getCaseStoreDatabase` lazy-async-singleton shape: the in-flight
 * slot is cleared on failure so a transient init error doesn't latch.
 */
export async function getAuth(): Promise<Auth> {
	if (_auth) return _auth;
	if (_authInFlight === null) {
		_authInFlight = createAuth();
		try {
			_auth = await _authInFlight;
		} finally {
			_authInFlight = null;
		}
		return _auth;
	}
	return _authInFlight;
}

/** Type-safe session type derived from the auth config. */
export type Session = Auth["$Infer"]["Session"];
