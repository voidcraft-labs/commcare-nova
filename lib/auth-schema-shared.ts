// Shared, import-light auth schema constants — the single source for the
// `auth_`-prefixed table names. Imported by BOTH the runtime auth config
// (`lib/auth.ts`) and the migration-only options (`lib/auth-migrate-options.ts`),
// so the table the migrator CREATES always matches the table the runtime READS
// (and the names `lib/db/oauth-consents.ts` / the data migration query). Kept
// free of plugin/MCP imports so the esbuild-bundled migrate entrypoint, which
// pulls `lib/auth-migrate-options.ts`, stays lean.

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
