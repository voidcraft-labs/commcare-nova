// Nova-owned UNIQUE index on the Better Auth `auth_member` table — defense in
// depth. The org plugin ships only per-column indexes on `organizationId` and
// `userId`, so nothing at the DB level stops two rows sharing an
// (organizationId, userId) pair, which would make the membership resolver read
// more than one role row. Personal-Project provisioning
// (lib/auth/provisionProject.ts) creates the owner membership inside the same
// transaction as the org and never duplicates it, but any other insert path
// (e.g. the plugin's own addMember) could; this index makes a duplicate
// membership impossible rather than merely unlikely.
//
// Runs AFTER Better Auth's own migrator (which creates `auth_member`) via the
// auth-app migrator (lib/auth/migrate.ts). `ifNotExists` so it self-adopts.
// `auth_member` is empty on the deploy that first introduces the org tables, so
// there are no pre-existing duplicates to block the unique build.

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
