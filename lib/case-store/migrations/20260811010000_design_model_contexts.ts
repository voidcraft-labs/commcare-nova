/** Durable append-only model-visible context for reviewed design/build roles. */

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_model_contexts (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			context_kind text NOT NULL CHECK (context_kind IN ('design', 'executor')),
			generation integer NOT NULL CHECK (generation >= 0),
			supersedes_context_id uuid UNIQUE
				REFERENCES design_model_contexts(id) ON DELETE CASCADE,
			model_id text NOT NULL CHECK (btrim(model_id) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			toolset_digest text NOT NULL CHECK (toolset_digest ~ ${sql.raw(SHA256_HEX)}),
			context_version text NOT NULL CHECK (btrim(context_version) <> ''),
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			UNIQUE (design_session_id, context_kind, generation),
			CHECK (
				(generation = 0 AND supersedes_context_id IS NULL)
				OR (generation > 0 AND supersedes_context_id IS NOT NULL)
			)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_model_steps (
			context_id uuid NOT NULL
				REFERENCES design_model_contexts(id) ON DELETE CASCADE,
			step_key text NOT NULL CHECK (btrim(step_key) <> ''),
			event_kind text NOT NULL CHECK (event_kind IN ('started', 'completed')),
			event_digest text NOT NULL CHECK (event_digest ~ ${sql.raw(SHA256_HEX)}),
			request_digest text CHECK (request_digest IS NULL OR request_digest ~ ${sql.raw(SHA256_HEX)}),
			response_digest text CHECK (response_digest IS NULL OR response_digest ~ ${sql.raw(SHA256_HEX)}),
			usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (context_id, step_key, event_kind),
			CHECK (
				(event_kind = 'started' AND request_digest IS NOT NULL AND response_digest IS NULL AND usage IS NULL)
				OR
				(event_kind = 'completed' AND request_digest IS NULL AND response_digest IS NOT NULL)
			)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_model_context_items (
			context_id uuid NOT NULL
				REFERENCES design_model_contexts(id) ON DELETE CASCADE,
			ordinal bigint NOT NULL CHECK (ordinal >= 1),
			append_key text NOT NULL CHECK (btrim(append_key) <> ''),
			append_index integer NOT NULL CHECK (append_index >= 0),
			item_digest text NOT NULL CHECK (item_digest ~ ${sql.raw(SHA256_HEX)}),
			message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (context_id, ordinal),
			UNIQUE (context_id, append_key, append_index)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_model_context_items`.execute(db);
	await sql`DROP TABLE IF EXISTS design_model_steps`.execute(db);
	await sql`DROP TABLE IF EXISTS design_model_contexts`.execute(db);
}
