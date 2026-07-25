// Retire run holders that predate the run-holder nonce.
//
// A holder minted before `run_holder_nonce` existed — or by a revision whose
// stamping trigger nulled it — carries no generation. Exact-nonce matching is
// now unconditional, so `toExactRunHolderIdentity` refuses to narrow such a
// row: the reapers can no longer free it, a Project move reads it as a corrupt
// holder, and the app is pinned to `generating` forever.
//
// These rows are abandoned by definition (their serving process is long gone),
// so this writes the terminal state `refundStaleGeneration` would have written:
// `error`, the paused-vs-crashed error type, and `awaiting_input` cleared.
//
// Two deliberate restrictions:
//   - Only holders untouched for an hour. The stale-build clock is ten minutes,
//     so an hour cannot reach a live run, and the migration Job runs while the
//     previous revision still serves.
//   - Only holders with no unsettled reservation. Settling one owes a credit
//     refund, and a schema migration must not move the credit ledger; there are
//     none in this state, and any that appeared would keep reaping normally
//     once a nonce-bearing revision claims them.
//
// Nothing recreates this state: every claim now mints a nonce and no trigger
// clears it, so this runs once and finds nothing thereafter.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE public.apps
		SET status = 'error',
			error_type = CASE WHEN awaiting_input THEN 'paused_timeout' ELSE 'internal' END,
			awaiting_input = false
		WHERE run_holder_nonce IS NULL
			AND (status = 'generating' OR lock_run_id IS NOT NULL)
			AND updated_at < now() - interval '1 hour'
			AND (res_run_id IS NULL OR res_settled IS DISTINCT FROM false)
	`.execute(db);
}

export async function down(): Promise<void> {
	// Intentionally empty. The previous state was an unreachable holder with no
	// serving process; restoring it would only re-strand the same rows.
}
