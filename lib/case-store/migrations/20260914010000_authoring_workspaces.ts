// Private canonical mutations and atomic checkpoint receipts for Markdown planning.
import { type Kysely, sql } from "kysely";

const CHANGE_SET_KINDS = "'genesis', 'app-edit'";
const CHANGE_SET_STATUSES = "'open', 'committed', 'abandoned', 'superseded'";
const EXCLUSIVE_KINDS = "'renameCaseProperties', 'retireCaseType'";
const REQUEST_STATUSES = "'staged', 'noop', 'rejected'";
const SHA256_HEX = "'^[0-9a-f]{64}$'";
export async function up(db: Kysely<unknown>): Promise<void> {
	// Translation batches are independent conversations, all recoverable.
	// Their sequence orders inspection; it does not supersede another batch.
	await sql`ALTER TABLE design_model_contexts DROP CONSTRAINT design_model_contexts_check`.execute(
		db,
	);
	await sql`ALTER TABLE design_model_contexts ADD CONSTRAINT design_model_contexts_check CHECK (
		(context_kind = 'translator' AND supersedes_context_id IS NULL)
		OR (context_kind <> 'translator' AND (
			(generation = 0 AND supersedes_context_id IS NULL)
			OR (generation > 0 AND supersedes_context_id IS NOT NULL)
		))
	)`.execute(db);
	await sql`ALTER TABLE design_model_contexts DROP CONSTRAINT design_model_contexts_context_kind_check`.execute(
		db,
	);
	await sql`ALTER TABLE design_model_contexts ADD CONSTRAINT design_model_contexts_context_kind_check
 CHECK (context_kind IN ('design', 'executor', 'architect', 'peer', 'translator'))`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS authoring_workspaces (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
			plan_revision bigint NOT NULL CHECK (plan_revision >= 1),
			kind text NOT NULL CHECK (kind IN (${sql.raw(CHANGE_SET_KINDS)})),
			app_id text REFERENCES apps(id) ON DELETE CASCADE,
			proposed_app_id text CHECK (btrim(proposed_app_id) <> ''),
			base_seq bigint CHECK (base_seq >= 1),
			base_project_id text NOT NULL CHECK (btrim(base_project_id) <> ''),
			base_snapshot_digest text NOT NULL
				CHECK (base_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			next_ordinal bigint NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
			exclusive_kind text
				CHECK (exclusive_kind IN (${sql.raw(EXCLUSIVE_KINDS)})),
			owner_user_id text NOT NULL CHECK (btrim(owner_user_id) <> ''),
			owner_run_id text NOT NULL CHECK (btrim(owner_run_id) <> ''),
			status text NOT NULL CHECK (status IN (${sql.raw(CHANGE_SET_STATUSES)})),
			committed_seq bigint CHECK (committed_seq >= 1),
			committed_batch_id text CHECK (btrim(committed_batch_id) <> ''),
			committed_snapshot_digest text
				CHECK (committed_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT authoring_workspaces_genesis_has_no_app
				CHECK ((kind = 'genesis') = (app_id IS NULL)),
			CONSTRAINT authoring_workspaces_genesis_has_proposed_app
				CHECK ((kind = 'genesis') = (proposed_app_id IS NOT NULL)),
			CONSTRAINT authoring_workspaces_genesis_has_no_base_seq
				CHECK ((kind = 'genesis') = (base_seq IS NULL)),
			CONSTRAINT authoring_workspaces_committed_seq_pairs_with_status
				CHECK ((status = 'committed') = (committed_seq IS NOT NULL)),
			CONSTRAINT authoring_workspaces_committed_batch_pairs_with_status
				CHECK ((status = 'committed') = (committed_batch_id IS NOT NULL)),
			CONSTRAINT authoring_workspaces_committed_digest_pairs_with_status
				CHECK ((status = 'committed') = (committed_snapshot_digest IS NOT NULL)),
			FOREIGN KEY (design_session_id, plan_revision) REFERENCES authoring_plan_revisions(session_id, revision)
		)
	`.execute(db);

	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS authoring_workspaces_open_session
			ON authoring_workspaces (design_session_id)
			WHERE status = 'open'
	`.execute(db);

	await sql`
		CREATE INDEX IF NOT EXISTS authoring_workspaces_app
			ON authoring_workspaces (app_id, status)
			WHERE app_id IS NOT NULL
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS authoring_requests (
			change_set_id uuid NOT NULL
				REFERENCES authoring_workspaces(id) ON DELETE CASCADE,
			request_id text NOT NULL CHECK (btrim(request_id) <> ''),
			tool_name text NOT NULL CHECK (btrim(tool_name) <> ''),
			input_digest text NOT NULL CHECK (input_digest ~ ${sql.raw(SHA256_HEX)}),
			expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
			resulting_revision bigint NOT NULL CHECK (resulting_revision >= 0),
			status text NOT NULL CHECK (status IN (${sql.raw(REQUEST_STATUSES)})),
			rejection_code text CHECK (btrim(rejection_code) <> ''),
			receipt jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (change_set_id, request_id),
			CONSTRAINT authoring_requests_rejection_pairs_with_status
				CHECK ((status = 'rejected') = (rejection_code IS NOT NULL)),
			CONSTRAINT authoring_requests_revision_advance
				CHECK (resulting_revision = expected_revision
					+ CASE WHEN status = 'staged' THEN 1 ELSE 0 END)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS authoring_steps (
			change_set_id uuid NOT NULL
				REFERENCES authoring_workspaces(id) ON DELETE CASCADE,
			ordinal bigint NOT NULL CHECK (ordinal >= 0),
			request_id text NOT NULL,
			tool_name text NOT NULL CHECK (btrim(tool_name) <> ''),
			mutations jsonb NOT NULL,
			mutation_digest text NOT NULL
				CHECK (mutation_digest ~ ${sql.raw(SHA256_HEX)}),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (change_set_id, ordinal),
			CONSTRAINT authoring_steps_one_step_per_request
				UNIQUE (change_set_id, request_id),
			CONSTRAINT authoring_steps_request_fk
				FOREIGN KEY (change_set_id, request_id)
				REFERENCES authoring_requests(change_set_id, request_id)
				ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS authoring_step_stages (
			change_set_id uuid NOT NULL,
			step_ordinal bigint NOT NULL,
			stage_ordinal integer NOT NULL CHECK (stage_ordinal >= 0),
			stage_name text NOT NULL CHECK (btrim(stage_name) <> ''),
			mutation_start integer NOT NULL CHECK (mutation_start >= 0),
			mutation_count integer NOT NULL CHECK (mutation_count >= 1),
			PRIMARY KEY (change_set_id, step_ordinal, stage_ordinal),
			CONSTRAINT authoring_step_stages_step_fk
				FOREIGN KEY (change_set_id, step_ordinal)
				REFERENCES authoring_steps(change_set_id, ordinal)
				ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS authoring_checkpoints (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
			request_id text NOT NULL CHECK (btrim(request_id) <> ''),
			plan_revision bigint NOT NULL CHECK (plan_revision >= 1),
			change_set_id uuid NOT NULL
				REFERENCES authoring_workspaces(id) ON DELETE CASCADE,
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			seq bigint NOT NULL CHECK (seq >= 1),
			batch_id text NOT NULL CHECK (btrim(batch_id) <> ''),
			committed_snapshot_digest text NOT NULL
				CHECK (committed_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			mutation_count integer NOT NULL CHECK (mutation_count >= 1),
			committed_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT authoring_checkpoints_change_set_unique
				UNIQUE (change_set_id),
			UNIQUE (design_session_id, request_id),
			CONSTRAINT authoring_checkpoints_app_seq_slice_unique
				UNIQUE (app_id, seq),
			CONSTRAINT authoring_checkpoints_plan_revision_fk
				FOREIGN KEY (design_session_id, plan_revision)
				REFERENCES authoring_plan_revisions(session_id, revision)
		)
	`.execute(db);
}
