import { type Kysely, sql } from "kysely";

/** Whole-call receipts are separate from individual worker action evidence. */
export async function up(db: Kysely<unknown>) {
	await sql`CREATE TABLE app_test_requests (
  test_id uuid NOT NULL REFERENCES app_test_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_id, request_id)
 )`.execute(db);
	await sql`ALTER TABLE app_test_steps DROP CONSTRAINT app_test_steps_test_id_request_id_key`.execute(
		db,
	);
	await sql`CREATE INDEX app_test_steps_request ON app_test_steps(test_id, request_id)`.execute(
		db,
	);
}

export async function down(_db: Kysely<unknown>) {
	throw new Error(
		"App test request receipts cannot be removed while preserving replay. Restore a database snapshot to roll back this migration.",
	);
}
