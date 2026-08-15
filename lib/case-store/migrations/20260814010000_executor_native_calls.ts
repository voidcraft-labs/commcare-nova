// Converge local Unit E databases onto the unreleased native-call executor
// schema. Fresh databases never create these retired protocol fields because
// the earlier Unit E migrations were corrected in place. No production row
// can depend on them: Unit E has not shipped.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS app_change_intents`.execute(db);
	await sql`
		ALTER TABLE design_change_set_steps
			DROP COLUMN IF EXISTS intent_ids
	`.execute(db);
	await sql`
		ALTER TABLE design_committed_slices
			DROP COLUMN IF EXISTS owning_intent_ids
	`.execute(db);
	await sql`
		ALTER TABLE design_change_sets
			DROP COLUMN IF EXISTS finalization_model_step
	`.execute(db);
	await sql`
		ALTER TABLE design_slice_attempts
			DROP COLUMN IF EXISTS validation_requested,
			DROP COLUMN IF EXISTS finalization_eligible
	`.execute(db);
	await sql`
		DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'design_slice_attempts'
					AND column_name = 'staged_requests_used'
			) AND NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'design_slice_attempts'
					AND column_name = 'mutation_calls_used'
			) THEN
				ALTER TABLE design_slice_attempts
					RENAME COLUMN staged_requests_used
					TO mutation_calls_used;
			END IF;
			IF EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'design_slice_attempts'
					AND column_name = 'stage_rejected_count'
			) AND NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'design_slice_attempts'
					AND column_name = 'private_mutation_rejected_count'
			) THEN
				ALTER TABLE design_slice_attempts
					RENAME COLUMN stage_rejected_count
					TO private_mutation_rejected_count;
			END IF;
		END $$
	`.execute(db);
	await sql`
		ALTER TABLE design_slice_attempt_budget_claims
			DROP CONSTRAINT IF EXISTS design_slice_attempt_budget_claims_counter_check
	`.execute(db);
	await sql`
		UPDATE design_slice_attempt_budget_claims
		SET counter = 'mutationCalls'
		WHERE counter = 'stagedRequests'
	`.execute(db);
	await sql`
		ALTER TABLE design_slice_attempt_budget_claims
			ADD CONSTRAINT design_slice_attempt_budget_claims_counter_check
			CHECK (
				counter IN ('modelSteps', 'mutationCalls', 'commitAttempts', 'blockerReports')
			)
	`.execute(db);
}

/** Unit E is unreleased and these shapes have no supported rollback reader. */
export async function down(_db: Kysely<unknown>): Promise<void> {}
