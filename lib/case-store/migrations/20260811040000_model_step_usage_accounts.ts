/** Exact-once bridge from durable model responses into run/monthly usage. */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE design_model_step_usage_accounts (
			context_id uuid NOT NULL,
			step_key text NOT NULL,
			event_kind text NOT NULL DEFAULT 'completed'
				CHECK (event_kind = 'completed'),
			run_id text NOT NULL CHECK (btrim(run_id) <> ''),
			accounted_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (context_id, step_key),
			FOREIGN KEY (context_id, step_key, event_kind)
				REFERENCES design_model_steps(context_id, step_key, event_kind)
				ON DELETE CASCADE
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE design_model_step_usage_accounts`.execute(db);
}
