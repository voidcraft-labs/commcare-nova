// Wall-clock budget becomes an active-time integrator.
//
// A slice attempt's wall-clock budget previously derived its deadline from
// `created_at` alone, so a process-death recovery inherited an ABSOLUTE
// deadline. The through-death resume path can only run after the build's
// ten-minute liveness horizon lapses plus a person clicking Resume, while
// every slice budget is at most twelve minutes — so a recovered attempt was
// born past its deadline and failed as `budget-exhausted` before its first
// model step, terminally sealing the slice. Dead time is not spend.
//
// These two columns make wall-clock spend durable and active-only:
// `wall_clock_ms_used` accrues at each genuine budget claim (the moments a
// holder is provably working), and `wall_clock_accrued_at` marks the instant
// the integrator last accrued to. Recovery resets the accrual instant without
// accruing, so the gap a dead process left behind never counts as spend.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_slice_attempts
			ADD COLUMN IF NOT EXISTS wall_clock_ms_used bigint NOT NULL DEFAULT 0
				CHECK (wall_clock_ms_used >= 0),
			ADD COLUMN IF NOT EXISTS wall_clock_accrued_at timestamptz NOT NULL DEFAULT now()
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_slice_attempts
			DROP COLUMN IF EXISTS wall_clock_accrued_at,
			DROP COLUMN IF EXISTS wall_clock_ms_used
	`.execute(db);
}
