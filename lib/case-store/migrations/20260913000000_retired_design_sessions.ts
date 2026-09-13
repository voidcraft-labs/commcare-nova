import { type Kysely, sql } from "kysely";

/** One-time data retirement is a separate scan/migrate operation. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_sessions
		DROP CONSTRAINT design_sessions_state_check,
		ADD CONSTRAINT design_sessions_state_check CHECK (
			state IN ('active', 'materialized', 'completed', 'abandoned', 'retired')
		),
		ADD CONSTRAINT design_sessions_retired_has_no_authority CHECK (
			state <> 'retired' OR (
				NOT awaiting_input AND run_id IS NULL AND run_holder_nonce IS NULL
				AND run_actor_user_id IS NULL AND run_mode IS NULL
				AND run_lease_expires_at IS NULL AND res_period IS NULL
				AND res_reserved IS NULL AND res_settled IS NULL
				AND res_user_id IS NULL AND res_run_id IS NULL
				AND active_design_revision_id IS NULL AND active_build_plan_id IS NULL
			)
		)
	`.execute(db);
}
