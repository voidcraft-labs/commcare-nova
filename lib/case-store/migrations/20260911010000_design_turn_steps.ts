import { type Kysely, sql } from "kysely";

/** Add provenance without changing any sealed historical step payload. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE design_model_steps ADD COLUMN turn_provenance_id text CHECK (turn_provenance_id IS NULL OR (event_kind = 'started' AND length(turn_provenance_id) BETWEEN 1 AND 1000))`.execute(
		db,
	);
	await sql`ALTER TABLE design_model_steps ADD COLUMN turn_provenance_digest text, ADD CHECK ((turn_provenance_id IS NULL AND turn_provenance_digest IS NULL) OR (turn_provenance_id IS NOT NULL AND turn_provenance_digest IS NOT NULL AND turn_provenance_digest ~ '^[a-f0-9]{64}$'))`.execute(
		db,
	);
	await sql`ALTER TABLE design_sessions ADD COLUMN continuation_recovery jsonb CHECK (continuation_recovery IS NULL OR jsonb_typeof(continuation_recovery) = 'object')`.execute(
		db,
	);
	await sql`CREATE INDEX design_model_steps_turn ON design_model_steps(context_id, turn_provenance_id) WHERE event_kind = 'started'`.execute(
		db,
	);
}
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE design_sessions DROP COLUMN continuation_recovery`.execute(
		db,
	);
	await sql`ALTER TABLE design_model_steps DROP COLUMN turn_provenance_id, DROP COLUMN turn_provenance_digest`.execute(
		db,
	);
}
