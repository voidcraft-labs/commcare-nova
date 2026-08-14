/** Idempotency keys for every durable executor sub-budget claim. */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_slice_attempt_budget_claims (
			attempt_id uuid NOT NULL
				REFERENCES design_slice_attempts(id) ON DELETE CASCADE,
			claim_key text NOT NULL CHECK (btrim(claim_key) <> ''),
			counter text NOT NULL CHECK (
				counter IN ('modelSteps', 'mutationCalls', 'commitAttempts', 'blockerReports')
			),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (attempt_id, claim_key)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_slice_attempt_budget_claims`.execute(
		db,
	);
}
