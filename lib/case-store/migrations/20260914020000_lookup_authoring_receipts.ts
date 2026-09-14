import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE lookup_authoring_receipts (
		project_id text NOT NULL,
		target_key text NOT NULL,
		request_id text NOT NULL CHECK (btrim(request_id) <> ''),
		input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
		receipt jsonb NOT NULL,
		actor_id text NOT NULL,
		run_id text NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (project_id, target_key, request_id)
	)`.execute(db);
}
