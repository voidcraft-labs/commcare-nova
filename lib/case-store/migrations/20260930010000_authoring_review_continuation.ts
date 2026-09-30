import { type Kysely, sql } from "kysely";

/** Additive lineage: unfinished investigations never gain a completed revision. */
export async function up(db: Kysely<unknown>) {
	await sql`ALTER TABLE authoring_reviews
 ADD COLUMN issuing_turn_id text,
 ADD COLUMN predecessor_review_id uuid REFERENCES authoring_reviews(id),
 ADD COLUMN paused_at timestamptz,
 ADD COLUMN checkpoint_summary text,
 ADD COLUMN checkpoint_context_id uuid REFERENCES design_model_contexts(id),
 ADD COLUMN summary_available boolean,
 ADD CONSTRAINT authoring_review_one_successor UNIQUE(predecessor_review_id),
 ADD CONSTRAINT authoring_review_unfinished CHECK(paused_at IS NULL OR completed_revision IS NULL)`.execute(
		db,
	);
}
export async function down(db: Kysely<unknown>) {
	await sql`ALTER TABLE authoring_reviews DROP CONSTRAINT authoring_review_unfinished,
 DROP CONSTRAINT authoring_review_one_successor, DROP COLUMN summary_available,
 DROP COLUMN checkpoint_context_id, DROP COLUMN checkpoint_summary,
 DROP COLUMN paused_at, DROP COLUMN predecessor_review_id, DROP COLUMN issuing_turn_id`.execute(
		db,
	);
}
