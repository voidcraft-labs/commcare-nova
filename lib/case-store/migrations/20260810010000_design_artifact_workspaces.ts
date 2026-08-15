// Durable private authoring workspaces for Design Contracts, revisions, and
// build plans. Immutable design artifacts remain insert-only; these rows hold
// only the bounded authoring operations that precede one atomic artifact
// finalization.

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_artifact_workspaces (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			artifact_kind text NOT NULL
				CHECK (artifact_kind IN ('contract', 'revision', 'plan')),
			lineage_digest text NOT NULL
				CHECK (lineage_digest ~ ${sql.raw(SHA256_HEX)}),
			lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			status text NOT NULL
				CHECK (status IN ('open', 'finalized', 'superseded')),
			finalized_artifact_id uuid,
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			updated_by_run_id text NOT NULL CHECK (btrim(updated_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			finalized_at timestamptz(3),
			CONSTRAINT design_artifact_workspaces_finalization_shape CHECK (
				(
					status = 'finalized'
					AND finalized_artifact_id IS NOT NULL
					AND finalized_at IS NOT NULL
				) OR (
					status <> 'finalized'
					AND finalized_artifact_id IS NULL
					AND finalized_at IS NULL
				)
			)
		)
	`.execute(db);

	// The exact live holder serializes workspace creation, and this index makes
	// more than one current workspace for the session structurally impossible.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS design_artifact_workspaces_one_open
			ON design_artifact_workspaces (design_session_id)
			WHERE status = 'open'
	`.execute(db);

	await sql`
		CREATE INDEX IF NOT EXISTS design_artifact_workspaces_session_lineage
			ON design_artifact_workspaces
				(design_session_id, artifact_kind, lineage_digest, updated_at DESC)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_artifact_workspace_steps (
			workspace_id uuid NOT NULL
				REFERENCES design_artifact_workspaces(id) ON DELETE CASCADE,
			revision bigint NOT NULL CHECK (revision >= 1),
			tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
			input_digest text NOT NULL CHECK (input_digest ~ ${sql.raw(SHA256_HEX)}),
			operation jsonb NOT NULL CHECK (jsonb_typeof(operation) = 'object'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, revision),
			CONSTRAINT design_artifact_workspace_steps_call_unique
				UNIQUE (workspace_id, tool_call_id)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_artifact_workspace_steps`.execute(db);
	await sql`DROP TABLE IF EXISTS design_artifact_workspaces`.execute(db);
}
