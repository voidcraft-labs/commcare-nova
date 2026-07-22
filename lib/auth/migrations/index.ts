// Auth-app migration set + provider — Nova-OWNED auth tables and invariants that
// Better Auth's own migrator does not manage (OAuth revocation state, membership
// uniqueness, and membership serialization). Static import-based provider (same
// rationale as the case-store provider: works inside the esbuild-bundled
// migrate entrypoint with no fs).
// Tracked in its OWN ledger (`auth_app_kysely_migration`) so it stays
// independent of both the case-store migrations and Better Auth's introspection.

import type { Migration, MigrationProvider } from "kysely/migration";
import * as oauthGrantRevocation from "./20260626000000_oauth_grant_revocation";
import * as authMemberUnique from "./20260627000000_auth_member_unique";
import * as authMemberSerialization from "./20260722070000_auth_member_serialization";

export const authAppMigrations: Record<string, Migration> = {
	"20260626000000_oauth_grant_revocation": oauthGrantRevocation,
	"20260627000000_auth_member_unique": authMemberUnique,
	"20260722070000_auth_member_serialization": authMemberSerialization,
};

export const authAppMigrationProvider: MigrationProvider = {
	getMigrations: async () => authAppMigrations,
};
