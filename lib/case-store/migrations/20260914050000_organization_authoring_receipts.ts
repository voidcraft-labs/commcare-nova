import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE organization_authoring_receipts (
		app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
		request_id text NOT NULL CHECK (btrim(request_id) <> ''),
		input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
		receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
		receipt jsonb NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (app_id, request_id)
	)`.execute(db);
}
