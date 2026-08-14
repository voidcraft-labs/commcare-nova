// The Atomic Change Set runtime — private durable staging for one slice
// executor, plus the committed-slice receipt lineage.
//
// Why these six tables exist:
//
//   * `design_change_sets` is the one mutable authority row per change set:
//     which base it was opened against (an exact app sequence, or the empty
//     genesis base with a proposed app id), who owns it, its monotonic
//     workspace revision, and its lifecycle (`open | committed | abandoned |
//     superseded`). There is deliberately NO intermediate `committing`
//     state: the canonical write and the `open -> committed` flip commit in
//     one transaction or neither does.
//
//   * `design_change_set_requests` is the durable idempotency ledger — one
//     row per staging request, keyed `(change_set_id, request_id)`, carrying
//     the exact input digest and the closed receipt a retry replays. A
//     request commits atomically with everything it staged; there is no
//     durable in-progress state, so one timestamp suffices.
//
//   * `design_change_set_steps` holds the exact admitted canonical mutation
//     batches, in append order. The private candidate is DERIVED (base +
//     steps replayed); it is never stored as a second document.
//
//   * `design_change_set_step_stages` keeps a step's stage ranges (name +
//     mutation span) without duplicating the mutations, so a later commit
//     can rebuild per-stage event envelopes.
//
//   * `design_change_set_handles` is the private symbol table: an
//     executor-local `@name` bound once to a server-minted canonical UUID
//     and entity kind. Handles never enter Blueprint state, history, or any
//     canonical surface; steps store resolved UUIDs only.
//
//   * `design_committed_slices` is the immutable committed-slice receipt,
//     inserted by the canonical commit's transaction sidecar beside the
//     status flip — the ONLY authority by which a slice is "committed".
//
// Design/plan identities (`design_session_id`, `design_revision_id`,
// `build_plan_id`, `slice_id`, `attempt_id`) are opaque non-null columns
// with no foreign keys yet: the tables they will reference ship with the
// design-session and orchestrator units, which add those constraints in
// their own migrations (docs/plans/reviewed-intent-atomic-change-sets-plan.md
// §18.7).
//
// Tenancy: `base_project_id` is the CAPTURED base scope, not live tenancy —
// an app Project move deliberately leaves open change sets behind (their
// commit rejects as PROJECT_CHANGED, the plan's terminal outcome), so no
// Project-move re-tenanting touches these rows. Committed lineage is
// app-keyed and follows the app implicitly.

import { type Kysely, sql } from "kysely";

const CHANGE_SET_KINDS = "'genesis', 'app-edit'";
const CHANGE_SET_STATUSES = "'open', 'committed', 'abandoned', 'superseded'";
const EXCLUSIVE_KINDS = "'renameCaseProperties', 'retireCaseType'";
const REQUEST_STATUSES = "'staged', 'rejected'";
const HANDLE_ENTITY_KINDS =
	"'module', 'form', 'field', 'option', 'case_list_column', 'search_input', 'case_operation', " +
	"'worker_property', 'user_type', 'persona', 'organization_level', 'location_property', " +
	"'automation', 'automation_criterion', 'automation_setup_criterion', 'automation_update', " +
	"'automation_recipient', 'automation_event', 'automation_user_data_filter'";
const SHA256_HEX = "'^[0-9a-f]{64}$'";
const CANONICAL_UUID =
	"'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'";
const HANDLE_SPELLING = "'^@[a-z][a-z0-9_-]{0,63}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_change_sets (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			design_revision_id uuid NOT NULL,
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			build_plan_id uuid NOT NULL,
			build_plan_digest text NOT NULL
				CHECK (build_plan_digest ~ ${sql.raw(SHA256_HEX)}),
			slice_id uuid NOT NULL,
			attempt_id uuid NOT NULL,
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
			-- The two base arms cannot mix: a genesis set has a proposed app id
			-- and no app row/base sequence; an app-edit set has exactly the
			-- opposite. Three biconditionals rather than one so a violation
			-- names the drifted column.
			CONSTRAINT design_change_sets_genesis_has_no_app
				CHECK ((kind = 'genesis') = (app_id IS NULL)),
			CONSTRAINT design_change_sets_genesis_has_proposed_app
				CHECK ((kind = 'genesis') = (proposed_app_id IS NOT NULL)),
			CONSTRAINT design_change_sets_genesis_has_no_base_seq
				CHECK ((kind = 'genesis') = (base_seq IS NULL)),
			-- Committed identity is all-or-none beside the status, so a
			-- "committed" row always names its exact canonical sequence, batch
			-- id, and snapshot digest — and nothing else ever carries them.
			CONSTRAINT design_change_sets_committed_seq_pairs_with_status
				CHECK ((status = 'committed') = (committed_seq IS NOT NULL)),
			CONSTRAINT design_change_sets_committed_batch_pairs_with_status
				CHECK ((status = 'committed') = (committed_batch_id IS NOT NULL)),
			CONSTRAINT design_change_sets_committed_digest_pairs_with_status
				CHECK ((status = 'committed') = (committed_snapshot_digest IS NOT NULL))
		)
	`.execute(db);

	// One open change set per slice attempt — the duplicate-worker fence.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS design_change_sets_open_attempt
			ON design_change_sets (attempt_id)
			WHERE status = 'open'
	`.execute(db);

	// Serves "does this app have an open change set" and the app-scoped
	// lifecycle reads (completion policy, admin inspect).
	await sql`
		CREATE INDEX IF NOT EXISTS design_change_sets_app
			ON design_change_sets (app_id, status)
			WHERE app_id IS NOT NULL
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_change_set_requests (
			change_set_id uuid NOT NULL
				REFERENCES design_change_sets(id) ON DELETE CASCADE,
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
			CONSTRAINT design_change_set_requests_rejection_pairs_with_status
				CHECK ((status = 'rejected') = (rejection_code IS NOT NULL)),
			-- A staged request advances the workspace revision by exactly one;
			-- a rejected request advances nothing.
			CONSTRAINT design_change_set_requests_revision_advance
				CHECK (resulting_revision = expected_revision
					+ CASE WHEN status = 'staged' THEN 1 ELSE 0 END)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_change_set_steps (
			change_set_id uuid NOT NULL
				REFERENCES design_change_sets(id) ON DELETE CASCADE,
			ordinal bigint NOT NULL CHECK (ordinal >= 0),
			request_id text NOT NULL,
			tool_name text NOT NULL CHECK (btrim(tool_name) <> ''),
			mutations jsonb NOT NULL,
			mutation_digest text NOT NULL
				CHECK (mutation_digest ~ ${sql.raw(SHA256_HEX)}),
			read_set jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (change_set_id, ordinal),
			CONSTRAINT design_change_set_steps_one_step_per_request
				UNIQUE (change_set_id, request_id),
			-- A step exists only for a request that committed beside it.
			CONSTRAINT design_change_set_steps_request_fk
				FOREIGN KEY (change_set_id, request_id)
				REFERENCES design_change_set_requests(change_set_id, request_id)
				ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_change_set_step_stages (
			change_set_id uuid NOT NULL,
			step_ordinal bigint NOT NULL,
			stage_ordinal integer NOT NULL CHECK (stage_ordinal >= 0),
			stage_name text NOT NULL CHECK (btrim(stage_name) <> ''),
			mutation_start integer NOT NULL CHECK (mutation_start >= 0),
			mutation_count integer NOT NULL CHECK (mutation_count >= 1),
			PRIMARY KEY (change_set_id, step_ordinal, stage_ordinal),
			CONSTRAINT design_change_set_step_stages_step_fk
				FOREIGN KEY (change_set_id, step_ordinal)
				REFERENCES design_change_set_steps(change_set_id, ordinal)
				ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_change_set_handles (
			change_set_id uuid NOT NULL
				REFERENCES design_change_sets(id) ON DELETE CASCADE,
			handle text NOT NULL CHECK (handle ~ ${sql.raw(HANDLE_SPELLING)}),
			uuid text NOT NULL CHECK (uuid ~ ${sql.raw(CANONICAL_UUID)}),
			entity_kind text NOT NULL
				CHECK (entity_kind IN (${sql.raw(HANDLE_ENTITY_KINDS)})),
			binding_request_id text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (change_set_id, handle),
			-- One handle per identity and one identity per handle, per set.
			CONSTRAINT design_change_set_handles_uuid_unique
				UNIQUE (change_set_id, uuid),
			CONSTRAINT design_change_set_handles_request_fk
				FOREIGN KEY (change_set_id, binding_request_id)
				REFERENCES design_change_set_requests(change_set_id, request_id)
				ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_committed_slices (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			design_revision_id uuid NOT NULL,
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			build_plan_id uuid NOT NULL,
			build_plan_digest text NOT NULL
				CHECK (build_plan_digest ~ ${sql.raw(SHA256_HEX)}),
			slice_id uuid NOT NULL,
			slice_attempt_id uuid NOT NULL,
			change_set_id uuid NOT NULL
				REFERENCES design_change_sets(id) ON DELETE CASCADE,
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			seq bigint NOT NULL CHECK (seq >= 1),
			batch_id text NOT NULL CHECK (btrim(batch_id) <> ''),
			committed_snapshot_digest text NOT NULL
				CHECK (committed_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),
			mutation_count integer NOT NULL CHECK (mutation_count >= 1),
			committed_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_committed_slices_change_set_unique
				UNIQUE (change_set_id),
			CONSTRAINT design_committed_slices_app_seq_slice_unique
				UNIQUE (app_id, seq, slice_id),
			CONSTRAINT design_committed_slices_plan_slice_unique
				UNIQUE (build_plan_id, slice_id)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_committed_slices`.execute(db);
	await sql`DROP TABLE IF EXISTS design_change_set_handles`.execute(db);
	await sql`DROP TABLE IF EXISTS design_change_set_step_stages`.execute(db);
	await sql`DROP TABLE IF EXISTS design_change_set_steps`.execute(db);
	await sql`DROP TABLE IF EXISTS design_change_set_requests`.execute(db);
	await sql`DROP TABLE IF EXISTS design_change_sets`.execute(db);
}
