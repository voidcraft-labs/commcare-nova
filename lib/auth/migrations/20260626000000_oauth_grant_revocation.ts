// Nova-owned per-(user, client) OAuth grant-revocation watermark. NOT a Better
// Auth model — Better Auth's migrator manages only its own `auth_*` tables, so
// this Nova-owned table is created by our own auth-app migrator
// (`lib/auth/migrate.ts`). `revokedAt` is the cutoff: a JWT whose `iat` precedes
// it is rejected for that (user, client). Column names are camelCase to match
// the rest of the auth schema. Idempotent (`IF NOT EXISTS`) so it self-adopts
// if the table somehow already exists.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE IF NOT EXISTS "auth_oauth_grant_revocation" (
		"userId" text NOT NULL,
		"clientId" text NOT NULL,
		"revokedAt" timestamptz NOT NULL,
		PRIMARY KEY ("userId", "clientId")
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS "auth_oauth_grant_revocation"`.execute(db);
}
