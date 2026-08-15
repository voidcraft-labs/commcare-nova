/** Durable post-slice localization attempts, paid batches, and receipts. */

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE design_localization_attempts (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			build_plan_id uuid NOT NULL REFERENCES design_build_plans(id),
			build_plan_digest text NOT NULL
				CHECK (build_plan_digest ~ ${sql.raw(SHA256_HEX)}),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			source_seq bigint NOT NULL CHECK (source_seq >= 1),
			source_snapshot_digest text NOT NULL
				CHECK (source_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			intent_digest text NOT NULL CHECK (intent_digest ~ ${sql.raw(SHA256_HEX)}),
			intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
			status text NOT NULL CHECK (status IN ('running', 'committed')),
			committed_seq bigint CHECK (committed_seq IS NULL OR committed_seq >= 1),
			committed_batch_id text
				CHECK (committed_batch_id IS NULL OR btrim(committed_batch_id) <> ''),
			committed_snapshot_digest text CHECK (
				committed_snapshot_digest IS NULL
				OR committed_snapshot_digest ~ ${sql.raw(SHA256_HEX)}
			),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			updated_by_run_id text NOT NULL CHECK (btrim(updated_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_localization_attempts_plan_unique UNIQUE (build_plan_id),
			CONSTRAINT design_localization_attempts_terminal_shape CHECK (
				(status = 'committed'
				 AND committed_seq IS NOT NULL
				 AND committed_batch_id IS NOT NULL
				 AND committed_snapshot_digest IS NOT NULL)
				OR
				(status <> 'committed'
				 AND committed_seq IS NULL
				 AND committed_batch_id IS NULL
				 AND committed_snapshot_digest IS NULL)
			)
		)
	`.execute(db);

	await sql`
		CREATE TABLE design_localization_batches (
			id uuid PRIMARY KEY,
			attempt_id uuid NOT NULL
				REFERENCES design_localization_attempts(id) ON DELETE CASCADE,
			batch_index integer NOT NULL CHECK (batch_index >= 0),
			source_language text NOT NULL CHECK (btrim(source_language) <> ''),
			target_language text NOT NULL CHECK (btrim(target_language) <> ''),
			unit_ids jsonb NOT NULL CHECK (jsonb_typeof(unit_ids) = 'array'),
			input_digest text NOT NULL CHECK (input_digest ~ ${sql.raw(SHA256_HEX)}),
			model_id text NOT NULL CHECK (btrim(model_id) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
			status text NOT NULL CHECK (status IN ('pending', 'running', 'accepted', 'failed')),
			claim_token uuid,
			claimed_by_run_id text
				CHECK (claimed_by_run_id IS NULL OR btrim(claimed_by_run_id) <> ''),
			output jsonb CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
			usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
			failure_code text CHECK (failure_code IS NULL OR btrim(failure_code) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_localization_batches_protocol_unique UNIQUE (
				attempt_id,
				batch_index,
				input_digest,
				model_id,
				prompt_version,
				schema_version
			),
			CONSTRAINT design_localization_batches_languages_differ
				CHECK (source_language <> target_language),
			CONSTRAINT design_localization_batches_claim_shape CHECK (
				(status = 'pending'
				 AND claim_token IS NULL
				 AND claimed_by_run_id IS NULL)
				OR
				(status <> 'pending'
				 AND claim_token IS NOT NULL
				 AND claimed_by_run_id IS NOT NULL)
			),
			CONSTRAINT design_localization_batches_output_shape CHECK (
				(status = 'accepted') = (output IS NOT NULL)
			),
			CONSTRAINT design_localization_batches_failure_shape CHECK (
				(status = 'failed') = (failure_code IS NOT NULL)
			),
			CONSTRAINT design_localization_batches_terminal_exclusive CHECK (
				(status = 'accepted' AND failure_code IS NULL)
				OR (status = 'failed' AND output IS NULL)
				OR (status IN ('pending', 'running') AND output IS NULL AND failure_code IS NULL)
			)
		)
	`.execute(db);

	await sql`
		CREATE TABLE design_localization_receipts (
			id uuid PRIMARY KEY,
			attempt_id uuid NOT NULL
				REFERENCES design_localization_attempts(id) ON DELETE CASCADE,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			build_plan_id uuid NOT NULL REFERENCES design_build_plans(id),
			build_plan_digest text NOT NULL
				CHECK (build_plan_digest ~ ${sql.raw(SHA256_HEX)}),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			source_seq bigint NOT NULL CHECK (source_seq >= 1),
			source_snapshot_digest text NOT NULL
				CHECK (source_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			seq bigint NOT NULL CHECK (seq >= 1),
			batch_id text NOT NULL CHECK (btrim(batch_id) <> ''),
			committed_snapshot_digest text NOT NULL
				CHECK (committed_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			mutation_count integer NOT NULL CHECK (mutation_count >= 1),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_localization_receipts_attempt_unique UNIQUE (attempt_id),
			CONSTRAINT design_localization_receipts_plan_unique UNIQUE (build_plan_id),
			CONSTRAINT design_localization_receipts_app_seq_unique UNIQUE (app_id, seq)
		)
	`.execute(db);

	await sql`
		CREATE TABLE design_localization_batch_usage_accounts (
			batch_id uuid PRIMARY KEY
				REFERENCES design_localization_batches(id) ON DELETE CASCADE,
			run_id text NOT NULL CHECK (btrim(run_id) <> ''),
			accounted_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE design_localization_batch_usage_accounts`.execute(db);
	await sql`DROP TABLE design_localization_receipts`.execute(db);
	await sql`DROP TABLE design_localization_batches`.execute(db);
	await sql`DROP TABLE design_localization_attempts`.execute(db);
}
