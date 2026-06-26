// Nova-owned per-(user, client) OAuth grant-revocation watermark. NOT a Better
// Auth model — Better Auth's migrator manages only its own `auth_*` tables, so
// this Nova-owned table is created by our own auth-app migrator
// (`lib/auth/migrate.ts`). `revokedAt` is the cutoff: a JWT whose `iat` precedes
// it is rejected for that (user, client). Column names are camelCase to match
// the rest of the auth schema. Built through Kysely's typed schema builder (no
// SQL literals); idempotent (`ifNotExists`) so it self-adopts if the table
// somehow already exists.

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("auth_oauth_grant_revocation")
		.ifNotExists()
		.addColumn("userId", "text", (col) => col.notNull())
		.addColumn("clientId", "text", (col) => col.notNull())
		.addColumn("revokedAt", "timestamptz", (col) => col.notNull())
		.addPrimaryKeyConstraint("auth_oauth_grant_revocation_pkey", [
			"userId",
			"clientId",
		])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("auth_oauth_grant_revocation").ifExists().execute();
}
