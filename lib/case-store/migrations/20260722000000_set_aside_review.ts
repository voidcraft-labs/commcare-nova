// The review surface's two data axes on `parked_case_values`:
//
//   - `dismissed_at` — the soft archive. A dismissed entry keeps its
//     data and leaves the active list (and the discovery badge count);
//     the review surface's Dismissed filter keeps it findable and
//     restorable. NULL = active.
//   - `from_type` / `to_type` — the transition captured at park time:
//     the data-type tokens the failed cast ran between. The review
//     surface groups entries by the conversion that set them aside,
//     and nothing else records the FROM side once the schema has
//     moved on (a `narrow-options` park carries its select type on
//     both sides — the "conversion" was an option removal).
//
// The type columns are NOT NULL with DEFAULT 'text'. The default is
// a safety net, not a data source, in two identical situations: the
// deploy window (the migrate Job runs while the PREVIOUS revision
// still serves, and that revision's park INSERT predates these
// columns — without a default, a park attempted in the window
// violates NOT NULL and aborts the user's whole blueprint commit)
// and rows parked before this migration existed (ADD COLUMN with a
// default backfills them in place). New code always writes explicit
// values, so the 'text' stamp only ever marks a park whose recorded
// transition predates the columns; both kinds read as a same-type
// park, and every live verdict is computed against the current
// declaration, never these columns.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "parked_case_values" ADD COLUMN IF NOT EXISTS "from_type" text NOT NULL DEFAULT 'text'`.execute(
		db,
	);
	await sql`ALTER TABLE "parked_case_values" ADD COLUMN IF NOT EXISTS "to_type" text NOT NULL DEFAULT 'text'`.execute(
		db,
	);
	await sql`ALTER TABLE "parked_case_values" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamptz`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "parked_case_values" DROP COLUMN IF EXISTS "dismissed_at"`.execute(
		db,
	);
	await sql`ALTER TABLE "parked_case_values" DROP COLUMN IF EXISTS "to_type"`.execute(
		db,
	);
	await sql`ALTER TABLE "parked_case_values" DROP COLUMN IF EXISTS "from_type"`.execute(
		db,
	);
}
