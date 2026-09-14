import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Old writers keep producing version zero until they have been drained.
	// The separate scan/migrate command converts their private state once.
	await sql`ALTER TABLE design_sessions ADD COLUMN authoring_version integer NOT NULL DEFAULT 0
		CHECK (authoring_version IN (0, 1))`.execute(db);
	await sql`ALTER TABLE authoring_plan_revisions DROP CONSTRAINT authoring_plan_revisions_editor_check`.execute(
		db,
	);
	await sql`ALTER TABLE authoring_plan_revisions ADD CONSTRAINT authoring_plan_revisions_editor_check
		CHECK (editor IN ('architect', 'peer', 'migration'))`.execute(db);
}
