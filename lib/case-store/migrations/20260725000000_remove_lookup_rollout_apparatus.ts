// Remove the lookup-reference version/rollout apparatus.
//
// Lookup carrier commits, destructive lookup schema actions, cross-Project app
// moves, and case-operation submission are unconditional features. Nothing
// reads a compatibility floor, holds a stream-capability lease, records a
// runtime-reader epoch, or declares a writer/runtime-reader version, so the
// storage and the database guards that enforced them are dropped: the three
// apparatus tables, the `apps.run_runtime_reader_version` census column, the
// statement- and row-level guard triggers on the tables that survive, and the
// five functions behind them.
//
// The run-holder nonce is unaffected and stays permanent — `apps
// .run_holder_nonce` and `threads.active_holder_nonce` are the run-holder
// generation identity that false-reap self-heal compares against. Dropping
// `nova_stamp_runtime_reader_holder` is what lets a nonce persist: that trigger
// NULLED every nonce write while the floor sat below 1.
//
// Ordering, as with any contract step: the migrate Job runs while the PREVIOUS
// revision still takes traffic, so that revision loses these tables before it
// stops serving and a request touching them fails until the new revision is
// live. That window is the ordinary deploy interruption, not a rollout.
//
// Forward-only. `down` cannot restore an apparatus the code no longer contains.

import { type Kysely, sql } from "kysely";

/** Guards on tables that survive; their function drops once they are gone. */
const GUARD_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> =
	[
		["apps", "apps_lookup_reference_writer_guard_insert"],
		["apps", "apps_lookup_reference_writer_guard_update"],
		["apps", "apps_lookup_reference_writer_guard_delete"],
		["apps", "apps_runtime_reader_holder_stamp"],
		["blueprint_entities", "blueprint_entities_lookup_reference_writer_guard"],
		["accepted_mutations", "accepted_mutations_lookup_reference_writer_guard"],
		["lookup_tables", "lookup_tables_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_retype"],
	];

/** Dropping a table takes its own triggers and indexes with it. */
const APPARATUS_TABLES = [
	"lookup_stream_capability_leases",
	"runtime_reader_traffic_epochs",
	"lookup_reference_compatibility",
];

const APPARATUS_FUNCTIONS = [
	"nova_guard_lookup_reference_compatibility_row",
	"nova_require_lookup_reference_writer_version",
	"nova_lock_deployment_cutover_gate",
	"nova_reject_runtime_epoch_truncate",
	"nova_stamp_runtime_reader_holder",
];

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const [table, trigger] of GUARD_TRIGGERS) {
		await sql`DROP TRIGGER IF EXISTS ${sql.id(trigger)} ON ${sql.table(table)}`.execute(
			db,
		);
	}
	for (const table of APPARATUS_TABLES) {
		await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
	}
	await sql`
		ALTER TABLE public.apps DROP COLUMN IF EXISTS run_runtime_reader_version
	`.execute(db);
	for (const fn of APPARATUS_FUNCTIONS) {
		await sql`DROP FUNCTION IF EXISTS ${sql.id(fn)}()`.execute(db);
	}
}

export async function down(): Promise<void> {
	// Intentionally empty. Re-creating the apparatus would mean re-authoring the
	// floors, leases, epochs, and guards this migration exists to delete; no
	// caller can use them, and local/test teardown drops the database outright.
}
