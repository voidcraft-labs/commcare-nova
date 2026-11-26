import { type Kysely, sql } from "kysely";

/** Only the operator writes these records. The application's historical receipts
 * keep their originally admitted bytes, digests, request identities and actors. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE authoring_workspace_folds (
			change_set_id uuid PRIMARY KEY REFERENCES authoring_workspaces(id) ON DELETE CASCADE,
			project_id text NOT NULL,
			app_id text NOT NULL,
			source_base_seq bigint CHECK (source_base_seq >= 0),
			effective_base_seq bigint CHECK (effective_base_seq >= 0),
			source_base_digest text NOT NULL CHECK (source_base_digest ~ '^[a-f0-9]{64}$'),
			effective_base_digest text NOT NULL CHECK (effective_base_digest ~ '^[a-f0-9]{64}$'),
			source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
			candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
			source_step_count bigint NOT NULL CHECK (source_step_count >= 0),
			base_snapshot jsonb,
			CHECK ((source_base_seq IS NULL) = (effective_base_seq IS NULL)),
			CHECK (base_snapshot IS NULL OR (effective_base_seq = source_base_seq AND source_base_seq IS NOT NULL))
		)
	`.execute(db);
	await sql`
		CREATE TABLE authoring_step_folds (
			change_set_id uuid NOT NULL REFERENCES authoring_workspace_folds(change_set_id) ON DELETE CASCADE,
			ordinal bigint NOT NULL,
			source_mutation_digest text NOT NULL CHECK (source_mutation_digest ~ '^[a-f0-9]{64}$'),
			mutation_digest text NOT NULL CHECK (mutation_digest ~ '^[a-f0-9]{64}$'),
			mutations jsonb NOT NULL CHECK (jsonb_typeof(mutations) = 'array'),
			mutation_lengths jsonb NOT NULL CHECK (jsonb_typeof(mutation_lengths) = 'array'),
			PRIMARY KEY (change_set_id, ordinal),
			FOREIGN KEY (change_set_id, ordinal) REFERENCES authoring_steps(change_set_id, ordinal) ON DELETE CASCADE
		)
	`.execute(db);
}
