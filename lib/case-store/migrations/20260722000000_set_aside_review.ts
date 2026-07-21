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
// the deploy-window safety net, not a data source: the migrate Job
// runs while the PREVIOUS revision still serves, and that revision's
// park INSERT predates these columns — without a default, a park
// attempted in the window violates NOT NULL and aborts the user's
// whole blueprint commit. New code always writes explicit values, so
// the default only ever stamps a park from that window (displayed as
// a same-type park; its live verdict is computed against the current
// declaration either way). Pre-existing rows are guarded, not
// defaulted — see below.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Guarded, not backfilled: a row existing before the columns do has
	// no recorded transition, and inventing one ("text → text") would
	// lie on the review surface forever. The replay case (adoption
	// tests erase the ledger and re-run everything) sees the columns
	// already present and skips the guard.
	await sql`DO $$
		DECLARE has_rows boolean;
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				 WHERE table_schema = 'public'
				   AND table_name = 'parked_case_values'
				   AND column_name = 'from_type'
			) THEN
				EXECUTE 'SELECT EXISTS (SELECT 1 FROM parked_case_values)' INTO has_rows;
				IF has_rows THEN
					RAISE EXCEPTION 'parked_case_values holds rows from before the transition columns existed — refusing to invent from_type/to_type for them. Each row''s reason names the cast that parked it; write a one-off backfill for the existing rows, then re-run.';
				END IF;
			END IF;
		END $$`.execute(db);
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
