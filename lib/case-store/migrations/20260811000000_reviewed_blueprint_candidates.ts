// Reviewed Blueprint candidates: the private Blueprint is the executable
// design. Plan/slice lineage belongs only to the dormant slice purpose;
// candidate rows bind directly to the design session and are checkpointed by
// exact workspace revision + digest for review and atomic materialization.

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_change_set_handles
			DROP CONSTRAINT IF EXISTS design_change_set_handles_entity_kind_check,
			ADD CONSTRAINT design_change_set_handles_entity_kind_check CHECK (
				entity_kind IN (
					'module', 'form', 'field', 'option',
					'case_list_column', 'search_input', 'case_operation',
					'worker_property', 'user_type', 'persona',
					'organization_level', 'location_property',
					'automation', 'automation_criterion',
					'automation_setup_criterion', 'automation_update',
					'automation_recipient', 'automation_event',
					'automation_user_data_filter'
				)
			)
	`.execute(db);
	await sql`
		ALTER TABLE design_change_sets
			ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'slice'
	`.execute(db);
	await sql`
		ALTER TABLE design_change_sets
			DROP CONSTRAINT IF EXISTS design_change_sets_purpose_shape
	`.execute(db);
	for (const column of [
		"design_revision_id",
		"design_revision_digest",
		"build_plan_id",
		"build_plan_digest",
		"slice_id",
		"attempt_id",
	]) {
		await sql`
			ALTER TABLE design_change_sets
				ALTER COLUMN ${sql.raw(column)} DROP NOT NULL
		`.execute(db);
	}
	await sql`
		ALTER TABLE design_change_sets
			ADD CONSTRAINT design_change_sets_purpose_shape CHECK (
				(purpose = 'slice'
					AND design_revision_id IS NOT NULL
					AND design_revision_digest IS NOT NULL
					AND build_plan_id IS NOT NULL
					AND build_plan_digest IS NOT NULL
					AND slice_id IS NOT NULL
					AND attempt_id IS NOT NULL)
				OR
				(purpose = 'design-candidate'
					AND kind = 'genesis'
					AND design_revision_id IS NULL
					AND design_revision_digest IS NULL
					AND build_plan_id IS NULL
					AND build_plan_digest IS NULL
					AND slice_id IS NULL
					AND attempt_id IS NULL)
			)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS design_change_sets_open_candidate
			ON design_change_sets (design_session_id)
			WHERE purpose = 'design-candidate' AND status = 'open'
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_candidate_checkpoints (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			change_set_id uuid NOT NULL
				REFERENCES design_change_sets(id) ON DELETE CASCADE,
			parent_checkpoint_id uuid
				REFERENCES design_candidate_checkpoints(id),
			lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'accepted')),
			workspace_revision bigint NOT NULL CHECK (workspace_revision >= 1),
			step_count bigint NOT NULL CHECK (step_count >= 1),
			candidate_digest text NOT NULL
				CHECK (candidate_digest ~ ${sql.raw(SHA256_HEX)}),
			source_package_digest text NOT NULL
				CHECK (source_package_digest ~ ${sql.raw(SHA256_HEX)}),
			brief_digest text NOT NULL
				CHECK (brief_digest ~ ${sql.raw(SHA256_HEX)}),
			brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_candidate_checkpoint_revision_unique
				UNIQUE (change_set_id, workspace_revision, lifecycle),
			CONSTRAINT design_candidate_checkpoint_parent_shape CHECK (
				lifecycle = 'draft' OR parent_checkpoint_id IS NOT NULL
			)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_candidate_reviews (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			checkpoint_id uuid NOT NULL
				REFERENCES design_candidate_checkpoints(id),
			review_kind text NOT NULL CHECK (review_kind IN ('full', 'verification')),
			candidate_digest text NOT NULL
				CHECK (candidate_digest ~ ${sql.raw(SHA256_HEX)}),
			artifact_digest text NOT NULL
				CHECK (artifact_digest ~ ${sql.raw(SHA256_HEX)}),
			producer_model text NOT NULL CHECK (btrim(producer_model) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_candidate_review_kind_unique
				UNIQUE (checkpoint_id, review_kind)
		)
	`.execute(db);

	await sql`
		ALTER TABLE design_sessions
			ADD COLUMN IF NOT EXISTS active_candidate_change_set_id uuid
				REFERENCES design_change_sets(id),
			ADD COLUMN IF NOT EXISTS active_candidate_checkpoint_id uuid
				REFERENCES design_candidate_checkpoints(id),
			ADD COLUMN IF NOT EXISTS active_candidate_review_id uuid
				REFERENCES design_candidate_reviews(id),
			ADD COLUMN IF NOT EXISTS candidate_phase text
				CHECK (candidate_phase IN (
					'authoring', 'reviewing', 'revising', 'accepted', 'blocked'
				))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_sessions
			DROP COLUMN IF EXISTS candidate_phase,
			DROP COLUMN IF EXISTS active_candidate_review_id,
			DROP COLUMN IF EXISTS active_candidate_checkpoint_id,
			DROP COLUMN IF EXISTS active_candidate_change_set_id
	`.execute(db);
	await sql`DROP TABLE IF EXISTS design_candidate_reviews`.execute(db);
	await sql`DROP TABLE IF EXISTS design_candidate_checkpoints`.execute(db);
	await sql`
		DELETE FROM design_change_sets
		WHERE purpose = 'design-candidate'
	`.execute(db);
	await sql`DROP INDEX IF EXISTS design_change_sets_open_candidate`.execute(db);
	await sql`
		ALTER TABLE design_change_sets
			DROP CONSTRAINT IF EXISTS design_change_sets_purpose_shape,
			DROP COLUMN IF EXISTS purpose
	`.execute(db);
	for (const column of [
		"design_revision_id",
		"design_revision_digest",
		"build_plan_id",
		"build_plan_digest",
		"slice_id",
		"attempt_id",
	]) {
		await sql`
			ALTER TABLE design_change_sets
				ALTER COLUMN ${sql.raw(column)} SET NOT NULL
		`.execute(db);
	}
	await sql`
		ALTER TABLE design_change_set_handles
			DROP CONSTRAINT IF EXISTS design_change_set_handles_entity_kind_check,
			ADD CONSTRAINT design_change_set_handles_entity_kind_check CHECK (
				entity_kind IN (
					'module', 'form', 'field', 'option',
					'case_list_column', 'search_input', 'case_operation',
					'organization_level', 'automation',
					'automation_criterion', 'automation_setup_criterion',
					'automation_update', 'automation_recipient',
					'automation_event', 'automation_user_data_filter'
				)
			)
	`.execute(db);
}
