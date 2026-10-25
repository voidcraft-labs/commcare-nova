// A publish writes where the app runs as the app's Web App setting
// (`cloudcare_enabled`) on every update, so HQ's read of it after the import
// repeats the declaration and is no longer kept. The setup artifact reads the
// declaration instead.
//
// Not additive: the revision before it reads and writes the column, so it is
// applied inside the cutover's maintenance window, never while that revision
// serves.

import { type Kysely, sql } from "kysely";

/** A publish writes where the app runs, so HQ's read of it is no longer kept. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments DROP COLUMN target_web_apps_enabled`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments ADD COLUMN target_web_apps_enabled boolean`.execute(
		db,
	);
}
