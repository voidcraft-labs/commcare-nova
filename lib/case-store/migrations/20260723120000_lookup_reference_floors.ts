// Final lookup-reference maintenance floors.
//
// Every serving revision declares writer v1 / stream-receiver v2 from
// config/runtime-capabilities.json, and the blocking migrate Job runs before a
// new revision takes traffic, so raising both floors here is a pure cutoff for
// pre-declaration writers and pre-registry stream receivers. The runtime-reader
// floor and every activation flag are untouched.
//
// The registry-epoch timestamp existed to prove no pre-registry stream could
// survive the first receiver cutoff. With the receiver floor permanently
// nonzero that state is unreachable, so the column drops in the same change.
// The GREATEST spellings keep the raise replay-idempotent for the ledger-erase
// replay tests; the compatibility row guard enforces monotonicity regardless.
//
// The DROP COLUMN must run BEFORE the floor UPDATE. The still-serving old
// revision's writer-guard triggers read the singleton FOR SHARE; updating the
// tuple first and then requesting the ALTER's ACCESS EXCLUSIVE lock lets a
// guard read wedge between the two statements — its ROW SHARE table lock
// blocks the ALTER while it waits on the updated tuple, a deadlock the
// detector may resolve by killing this deploy-blocking Job. Taking ACCESS
// EXCLUSIVE first queues every guard read behind the table lock instead.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP COLUMN IF EXISTS continuous_registry_traffic_since
	`.execute(db);

	await sql`
		UPDATE public.lookup_reference_compatibility
		SET
			minimum_writer_version = GREATEST(minimum_writer_version, 1),
			minimum_stream_receiver_version =
				GREATEST(minimum_stream_receiver_version, 2),
			updated_at = clock_timestamp()
		WHERE id = 1
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Test/local teardown only; a deployed compatibility change fixes forward.
	// Floors are monotonic and deliberately stay raised.
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD COLUMN IF NOT EXISTS continuous_registry_traffic_since timestamptz(3)
	`.execute(db);
}
