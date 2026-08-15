// Build-orchestrator durable state — the append-only orchestration event
// chain and the mutable slice-attempt control rows
// (docs/plans/reviewed-intent-atomic-change-sets-plan.md §13.2, §13.3,
// §18.5, §18.6).
//
// What this migration establishes:
//
//   * `design_orchestration_events` — the append-only transition chain one
//     build orchestrator folds into its current state. Every event names its
//     predecessor by id AND digest; the partial unique index on
//     `(design_session_id, predecessor_event_id)` is what makes two
//     continuations structurally unable to advance the same state, and the
//     `(design_session_id, revision)` primary key keeps the chain contiguous.
//     Raw holder nonces never land here — `holder_nonce_digest` is the safe
//     audit projection; the session/app row remains the only nonce authority.
//
//   * `design_slice_attempts` — the mutable execution-control row for one
//     bounded executor run over one build slice. Input identities are
//     immutable; only `status` (+ failure metadata and the once-set
//     `change_set_id`) moves. The partial unique index permits one `running`
//     attempt per `(design_session_id, build_plan_id, slice_id)`; the plain
//     unique constraint pins the attempt numbering.
//
//   * The change-set tables' remaining opaque identity columns gain their
//     foreign keys — 20260807000000 deliberately deferred them "until the
//     orchestrator unit lands its tables and adds their keys in its own
//     migration": `design_change_sets` and `design_committed_slices` bind
//     `design_revision_id` → `design_revisions`, `build_plan_id` →
//     `design_build_plans`, and `attempt_id`/`slice_attempt_id` →
//     `design_slice_attempts`. (`slice_id` stays opaque by design — it is a
//     contract-internal DesignId, not a table row.)
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

const ATTEMPT_STATUSES = "'running', 'committed', 'superseded', 'failed'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_orchestration_events (
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			revision bigint NOT NULL CHECK (revision >= 1),
			event_id uuid NOT NULL,
			predecessor_event_id uuid,
			predecessor_digest text
				CHECK (predecessor_digest IS NULL OR predecessor_digest ~ ${sql.raw(SHA256_HEX)}),
			run_id text NOT NULL CHECK (btrim(run_id) <> ''),
			holder_nonce_digest text NOT NULL
				CHECK (holder_nonce_digest ~ ${sql.raw(SHA256_HEX)}),
			kind text NOT NULL CHECK (btrim(kind) <> ''),
			payload jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (design_session_id, revision),
			CONSTRAINT design_orchestration_events_event_unique
				UNIQUE (design_session_id, event_id),
			-- The chain's shape: exactly the first event has no predecessor,
			-- and a predecessor id always travels with its digest.
			CONSTRAINT design_orchestration_events_first_has_no_predecessor CHECK (
				(revision = 1) = (predecessor_event_id IS NULL)
			),
			CONSTRAINT design_orchestration_events_predecessor_pair CHECK (
				(predecessor_event_id IS NULL) = (predecessor_digest IS NULL)
			)
		)
	`.execute(db);
	// Two continuations cannot advance the same state: the second insert
	// naming an already-consumed predecessor violates this index.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS design_orchestration_events_predecessor
			ON design_orchestration_events (design_session_id, predecessor_event_id)
			WHERE predecessor_event_id IS NOT NULL
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_slice_attempts (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			build_plan_id uuid NOT NULL REFERENCES design_build_plans(id),
			build_plan_digest text NOT NULL
				CHECK (build_plan_digest ~ ${sql.raw(SHA256_HEX)}),
			slice_id uuid NOT NULL,
			attempt integer NOT NULL CHECK (attempt >= 1),

			base_kind text NOT NULL CHECK (base_kind IN ('empty-genesis', 'app')),
			base_app_id text REFERENCES apps(id) ON DELETE CASCADE,
			base_proposed_app_id text
				CHECK (base_proposed_app_id IS NULL OR btrim(base_proposed_app_id) <> ''),
			base_seq bigint CHECK (base_seq IS NULL OR base_seq >= 1),
			base_snapshot_digest text NOT NULL
				CHECK (base_snapshot_digest ~ ${sql.raw(SHA256_HEX)}),

			change_set_id uuid REFERENCES design_change_sets(id),
			executor_model text NOT NULL CHECK (btrim(executor_model) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			brief_digest text NOT NULL CHECK (brief_digest ~ ${sql.raw(SHA256_HEX)}),

			status text NOT NULL CHECK (status IN (${sql.raw(ATTEMPT_STATUSES)})),
			failure_code text CHECK (failure_code IS NULL OR btrim(failure_code) <> ''),

			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),

			-- The base target is exactly one of the two shapes.
			CONSTRAINT design_slice_attempts_base_shape CHECK (
				(base_kind = 'empty-genesis'
					AND base_proposed_app_id IS NOT NULL
					AND base_app_id IS NULL AND base_seq IS NULL)
				OR
				(base_kind = 'app'
					AND base_app_id IS NOT NULL AND base_seq IS NOT NULL
					AND base_proposed_app_id IS NULL)
			),
			CONSTRAINT design_slice_attempts_numbering_unique
				UNIQUE (design_session_id, build_plan_id, slice_id, attempt)
		)
	`.execute(db);
	// One live worker per slice: a second `running` attempt for the same
	// slice is unrepresentable.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS design_slice_attempts_one_running
			ON design_slice_attempts (design_session_id, build_plan_id, slice_id)
			WHERE status = 'running'
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_external_action_receipts (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			build_plan_id uuid NOT NULL REFERENCES design_build_plans(id),
			external_action_id uuid NOT NULL,
			project_id text NOT NULL,
			app_id text REFERENCES apps(id) ON DELETE CASCADE,
			action_digest text NOT NULL
				CHECK (action_digest ~ ${sql.raw(SHA256_HEX)}),
			outcome text NOT NULL
				CHECK (outcome IN ('completed', 'manual-confirmed')),
			evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
			completed_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_external_action_receipts_scope_unique
				UNIQUE NULLS NOT DISTINCT (
					design_session_id, build_plan_id, external_action_id, app_id
				)
		)
	`.execute(db);

	// Bind the change-set tables' opaque identity columns. Drop-before-add
	// keeps the replay idempotent (Postgres has no ADD CONSTRAINT IF NOT
	// EXISTS).
	for (const [table, column, target, constraint] of DEFERRED_IDENTITY_FKS) {
		await sql`
			ALTER TABLE ${sql.raw(table)}
				DROP CONSTRAINT IF EXISTS ${sql.raw(constraint)}
		`.execute(db);
		await sql`
			ALTER TABLE ${sql.raw(table)}
				ADD CONSTRAINT ${sql.raw(constraint)}
				FOREIGN KEY (${sql.raw(column)}) REFERENCES ${sql.raw(target)}(id)
		`.execute(db);
	}
}

const DEFERRED_IDENTITY_FKS = [
	[
		"design_change_sets",
		"design_revision_id",
		"design_revisions",
		"design_change_sets_design_revision_fk",
	],
	[
		"design_change_sets",
		"build_plan_id",
		"design_build_plans",
		"design_change_sets_build_plan_fk",
	],
	[
		"design_change_sets",
		"attempt_id",
		"design_slice_attempts",
		"design_change_sets_attempt_fk",
	],
	[
		"design_committed_slices",
		"design_revision_id",
		"design_revisions",
		"design_committed_slices_design_revision_fk",
	],
	[
		"design_committed_slices",
		"build_plan_id",
		"design_build_plans",
		"design_committed_slices_build_plan_fk",
	],
	[
		"design_committed_slices",
		"slice_attempt_id",
		"design_slice_attempts",
		"design_committed_slices_slice_attempt_fk",
	],
] as const;

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const [table, , , constraint] of [...DEFERRED_IDENTITY_FKS].reverse()) {
		await sql`
			ALTER TABLE ${sql.raw(table)}
				DROP CONSTRAINT IF EXISTS ${sql.raw(constraint)}
		`.execute(db);
	}
	await sql`DROP TABLE IF EXISTS design_external_action_receipts`.execute(db);
	await sql`DROP TABLE IF EXISTS design_slice_attempts`.execute(db);
	await sql`DROP TABLE IF EXISTS design_orchestration_events`.execute(db);
}
