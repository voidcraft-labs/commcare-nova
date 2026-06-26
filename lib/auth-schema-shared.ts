// Shared, import-light auth schema constants — the single source for the
// `auth_`-prefixed table names on the WRITE side: imported by the runtime auth
// config (`lib/auth.ts`, the per-model `modelName`) and the migration-only
// options (`lib/auth-migrate-options.ts`, what the migrator CREATES), so those
// two can't diverge. Kept free of plugin/MCP imports so the esbuild-bundled
// migrate entrypoint (which pulls `lib/auth-migrate-options.ts`) stays lean.
//
// The READ side does NOT import these: the Kysely interfaces (`AuthDatabase` in
// `lib/auth/db.ts`, `CopyTables` in `lib/auth/migrate-data.ts`) and the
// `selectFrom("auth_…")` literals in the read modules hardcode the same names —
// Kysely table keys must be literal types, so they can't reference this const.
// A rename here therefore must be mirrored into those interfaces by hand; the
// compiler will NOT flag the read side (it still type-checks against its own
// interface), so a missed mirror surfaces as a runtime "relation does not exist".

export const AUTH_TABLE_NAMES = {
	user: "auth_user",
	session: "auth_session",
	account: "auth_account",
	verification: "auth_verification",
	rateLimit: "auth_rate_limit",
	jwks: "auth_jwks",
	apikey: "auth_apikey",
	oauthClient: "auth_oauth_client",
	oauthConsent: "auth_oauth_consent",
	oauthRefreshToken: "auth_oauth_refresh_token",
	oauthAccessToken: "auth_oauth_access_token",
} as const;
