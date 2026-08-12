/** Durable symbolic identities for Design Contract authoring. */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_identity_handles (
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			handle text NOT NULL CHECK (handle ~ '^@[a-z][a-z0-9_-]{0,62}$'),
			design_id uuid NOT NULL,
			entity_kind text NOT NULL CHECK (entity_kind IN (
				'contract', 'actor', 'record', 'property', 'workflow', 'list',
				'access', 'navigation', 'external_requirement', 'decision',
				'assumption', 'open_question'
			)),
			workspace_id uuid NOT NULL
				REFERENCES design_artifact_workspaces(id) ON DELETE CASCADE,
			tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (design_session_id, handle),
			UNIQUE (design_session_id, design_id)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_identity_handles`.execute(db);
}
