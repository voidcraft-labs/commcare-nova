// Nova-owned UNIQUE index on the Better Auth `auth_member` table. The org
// plugin ships only per-column indexes on `organizationId` and `userId`, so a
// select-then-insert provisioning path (lib/auth/provisionProject.ts) could
// otherwise race two duplicate owner memberships into existence and the
// membership resolver would read more than one row. This index is what makes
// the `ON CONFLICT (organizationId, userId) DO NOTHING` insert idempotent.
//
// Runs AFTER Better Auth's own migrator (which creates `auth_member`) via the
// auth-app migrator (lib/auth/migrate.ts). `ifNotExists` so it self-adopts.
// auth_member starts empty when this first runs, so there are no pre-existing
// duplicates to block the unique build.

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("auth_member_organization_user_unique")
		.ifNotExists()
		.unique()
		.on("auth_member")
		.columns(["organizationId", "userId"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.dropIndex("auth_member_organization_user_unique")
		.ifExists()
		.execute();
}
