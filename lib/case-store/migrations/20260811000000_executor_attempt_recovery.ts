// Durable executor recovery convergence.
//
// `20260807000000_design_change_sets` originally admitted only the structural
// handle kinds that existed when that migration ran. Editing that historical
// migration helps fresh databases but cannot change an already-installed CHECK
// constraint, so this forward migration replaces it with the complete durable
// handle vocabulary.
//
// Slice attempts also own their consumed execution counters. A replacement
// process recovers these fields instead of receiving a fresh attempt budget.

import { type Kysely, sql } from "kysely";

const HANDLE_ENTITY_KINDS =
	"'module', 'form', 'field', 'option', 'case_list_column', 'search_input', 'case_operation', " +
	"'worker_property', 'user_type', 'persona', 'organization_level', 'location_property', " +
	"'automation', 'automation_criterion', 'automation_setup_criterion', 'automation_update', " +
	"'automation_recipient', 'automation_event', 'automation_user_data_filter'";

const ORIGINAL_HANDLE_ENTITY_KINDS =
	"'module', 'form', 'field', 'option', 'case_list_column', 'search_input', 'case_operation'";

const HANDLE_KIND_CHECK = "design_change_set_handles_entity_kind_check";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_change_set_handles
			DROP CONSTRAINT IF EXISTS ${sql.id(HANDLE_KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(HANDLE_KIND_CHECK)}
				CHECK (entity_kind IN (${sql.raw(HANDLE_ENTITY_KINDS)}))
	`.execute(db);

	await sql`
		ALTER TABLE design_slice_attempts
			ADD COLUMN IF NOT EXISTS model_steps_used integer NOT NULL DEFAULT 0
				CHECK (model_steps_used >= 0),
			ADD COLUMN IF NOT EXISTS mutation_calls_used integer NOT NULL DEFAULT 0
				CHECK (mutation_calls_used >= 0),
			ADD COLUMN IF NOT EXISTS commit_attempts_used integer NOT NULL DEFAULT 0
				CHECK (commit_attempts_used >= 0),
			ADD COLUMN IF NOT EXISTS blocker_reports_used integer NOT NULL DEFAULT 0
				CHECK (blocker_reports_used >= 0),
			ADD COLUMN IF NOT EXISTS execution_run_ids jsonb NOT NULL DEFAULT '[]'::jsonb
				CHECK (jsonb_typeof(execution_run_ids) = 'array'),
			ADD COLUMN IF NOT EXISTS wire_invalid_count integer NOT NULL DEFAULT 0
				CHECK (wire_invalid_count >= 0),
			ADD COLUMN IF NOT EXISTS private_mutation_rejected_count integer NOT NULL DEFAULT 0
				CHECK (private_mutation_rejected_count >= 0),
			ADD COLUMN IF NOT EXISTS validator_repair_count integer NOT NULL DEFAULT 0
				CHECK (validator_repair_count >= 0),
			ADD COLUMN IF NOT EXISTS outcome_evidence_state text NOT NULL
				DEFAULT 'legacy-missing'
				CHECK (outcome_evidence_state IN (
					'legacy-missing', 'unstarted', 'collecting', 'complete', 'incomplete'
				))
	`.execute(db);
	await sql`
		ALTER TABLE design_change_set_requests
			DROP CONSTRAINT IF EXISTS design_change_set_requests_status_check,
			ADD CONSTRAINT design_change_set_requests_status_check
				CHECK (status IN ('staged', 'noop', 'rejected'))
	`.execute(db);

	/* The attempt table and its first writer ship in this same deployment. The
	 * old serving revision cannot create attempt rows, so there is no live data
	 * to backfill and no rolling-deploy writer race. Recovery state starts at
	 * the declared defaults for every attempt minted by the new writer. */
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_change_set_requests
			DROP CONSTRAINT IF EXISTS design_change_set_requests_status_check,
			ADD CONSTRAINT design_change_set_requests_status_check
				CHECK (status IN ('staged', 'rejected'))
	`.execute(db);
	await sql`
		ALTER TABLE design_slice_attempts
			DROP COLUMN IF EXISTS outcome_evidence_state,
			DROP COLUMN IF EXISTS validator_repair_count,
			DROP COLUMN IF EXISTS private_mutation_rejected_count,
			DROP COLUMN IF EXISTS wire_invalid_count,
			DROP COLUMN IF EXISTS execution_run_ids,
			DROP COLUMN IF EXISTS blocker_reports_used,
			DROP COLUMN IF EXISTS commit_attempts_used,
			DROP COLUMN IF EXISTS mutation_calls_used,
			DROP COLUMN IF EXISTS model_steps_used
	`.execute(db);
	await sql`
		ALTER TABLE design_change_set_handles
			DROP CONSTRAINT IF EXISTS ${sql.id(HANDLE_KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(HANDLE_KIND_CHECK)}
				CHECK (entity_kind IN (${sql.raw(ORIGINAL_HANDLE_ENTITY_KINDS)}))
	`.execute(db);
}
