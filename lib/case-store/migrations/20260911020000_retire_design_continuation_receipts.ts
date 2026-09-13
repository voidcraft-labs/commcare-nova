import { type Kysely, sql } from "kysely";

/** The local and production data conversion is complete. Keep normal turn
 * accounting, but remove its one-time operator receipt. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ BEGIN
  IF EXISTS (
   SELECT 1 FROM design_model_steps step
   JOIN design_model_contexts context ON context.id = step.context_id
   WHERE context.context_kind = 'design' AND step.event_kind = 'started'
    AND step.turn_provenance_id IS NULL
  ) THEN
   RAISE EXCEPTION 'Design turn provenance must be complete before retiring migration receipts';
  END IF;
 END $$`.execute(db);
	await sql`ALTER TABLE design_sessions DROP COLUMN continuation_recovery`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE design_sessions ADD COLUMN continuation_recovery jsonb CHECK (continuation_recovery IS NULL OR jsonb_typeof(continuation_recovery) = 'object')`.execute(
		db,
	);
}
