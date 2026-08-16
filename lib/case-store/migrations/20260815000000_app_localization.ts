// Add the optional app-level localization overlay. Existing null rows are the
// exact legacy single-English state, so this migration needs no data rewrite.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE apps ADD COLUMN IF NOT EXISTS localization jsonb`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE apps DROP COLUMN IF EXISTS localization`.execute(db);
}
