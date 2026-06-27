// Auth-app migration set + provider — Nova-OWNED auth tables that Better Auth's
// own migrator does not manage (currently just the OAuth grant-revocation
// watermark). Static import-based provider (same rationale as the case-store
// provider: works inside the esbuild-bundled migrate entrypoint with no fs).
// Tracked in its OWN ledger (`auth_app_kysely_migration`) so it stays
// independent of both the case-store migrations and Better Auth's introspection.

import type { Migration, MigrationProvider } from "kysely/migration";
import * as oauthGrantRevocation from "./20260626000000_oauth_grant_revocation";

export const authAppMigrations: Record<string, Migration> = {
	"20260626000000_oauth_grant_revocation": oauthGrantRevocation,
};

export const authAppMigrationProvider: MigrationProvider = {
	getMigrations: async () => authAppMigrations,
};
