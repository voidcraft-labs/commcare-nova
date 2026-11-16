// Where a Project's lookup table and an app's places came from in CommCare HQ,
// additive for the revision that serves while it runs.
//
//   (1-4) `lookup_tables`: the project space a table was brought in from, its
//         id there, the canonical value of its last refresh, who brought it
//         in and refreshed it and when, and who took it over to manage in
//         Nova and when. One CHECK holds the origin whole or wholly absent,
//         another holds a takeover attributed and only on a table with an
//         origin; a partial index finds a Project's brought-in tables by
//         project space.
//   (5-6) `app_organization_state`: the project space an app's places were
//         brought in from, the digest of the places as read, what the reading
//         left out, and who brought them in and refreshed them and when, held
//         whole or wholly absent the same way.
//   (7)   `app_locations.hq_location_id`: CommCare HQ's id of a managed place,
//         and `hq_gone_at`: when a refresh found a place CommCare HQ no longer
//         has and kept it, because the app still uses it.
//
// Every new column is nullable with no default, and each CHECK reads only the
// columns this migration adds, which the serving revision names in no insert
// or update: every row it writes leaves them as they were, and every row
// stored before passes with them null. Every statement replays over its own
// result, because the adoption tests erase the migration ledger and run the
// chain again.
//
// The serving revision reads and writes the three tables this changes, and the
// batch reaches this migration already holding tables an earlier migration of
// it altered, `lookup_tables` among them. A migration that waited for one of
// these three while the batch held another would close a cycle with a request
// that held the second and waited for the first: the serving revision's App
// Test start clones `app_locations` and then `lookup_tables`, keeping each until
// it commits. So statement 0b takes all three before the first change, never
// waiting while it holds one: it asks for all of them at once without waiting,
// gives back what it got when any is busy, and asks again until five seconds
// have passed. Contention can then only end with the Job failing and nothing
// applied; a request only waits for the commit. Statement 8 hands statement 0's
// timeout back as it found it.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// 0. Wait five seconds for a lock, and no longer, while the previous revision serves.
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

	// 0b. The three tables, all at once and only while none is busy, so it never
	//     waits while it holds one. ACCESS EXCLUSIVE, which each ALTER below
	//     takes. A lock taken in the inner block is released when that block
	//     fails; one the batch took before this migration stays held.
	await sql`
		DO $$
		DECLARE
			deadline constant timestamptz := clock_timestamp() + interval '5 seconds';
		BEGIN
			LOOP
				BEGIN
					LOCK TABLE public.lookup_tables, public.app_organization_state,
						public.app_locations IN ACCESS EXCLUSIVE MODE NOWAIT;
					RETURN;
				EXCEPTION WHEN lock_not_available THEN
					IF clock_timestamp() >= deadline THEN
						RAISE EXCEPTION USING ERRCODE = 'lock_not_available',
							MESSAGE = 'The bring-in project data migration could not take lookup_tables, app_organization_state and app_locations together within five seconds, because the serving revision was using one of them each time it asked. It never waits for one while it holds another, so it stopped, and nothing was changed. Running the deploy again tries again.';
					END IF;
				END;
				PERFORM pg_sleep(0.01);
			END LOOP;
		END $$
	`.execute(db);

	// 1. A lookup table's origin in CommCare HQ and its takeover.
	await sql`
		ALTER TABLE public.lookup_tables
			ADD COLUMN IF NOT EXISTS hq_server text,
			ADD COLUMN IF NOT EXISTS hq_domain text,
			ADD COLUMN IF NOT EXISTS hq_remote_id text,
			ADD COLUMN IF NOT EXISTS hq_canonical jsonb,
			ADD COLUMN IF NOT EXISTS hq_brought_in_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS hq_brought_in_by text,
			ADD COLUMN IF NOT EXISTS hq_refreshed_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS hq_refreshed_by text,
			ADD COLUMN IF NOT EXISTS hq_taken_over_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS hq_taken_over_by text
	`.execute(db);

	// 2. The origin is whole or wholly absent. The server names are the
	//    deployment ledger's. The second arm must be true, not unknown: a CHECK
	//    admits a row its expression leaves NULL, and `btrim`, `jsonb_typeof`,
	//    `->>` and `~` each answer NULL for a column the origin leaves null.
	await sql`
		ALTER TABLE public.lookup_tables DROP CONSTRAINT IF EXISTS lookup_tables_hq_origin_whole
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_tables ADD CONSTRAINT lookup_tables_hq_origin_whole CHECK (
			(hq_server IS NULL AND hq_domain IS NULL AND hq_remote_id IS NULL AND hq_canonical IS NULL
				AND hq_brought_in_at IS NULL AND hq_brought_in_by IS NULL
				AND hq_refreshed_at IS NULL AND hq_refreshed_by IS NULL)
			OR (hq_server IN ('production', 'india', 'eu')
				AND btrim(hq_domain) <> '' AND char_length(hq_domain) <= 255
				AND btrim(hq_remote_id) <> ''
				AND jsonb_typeof(hq_canonical) = 'object'
				AND hq_canonical ->> 'digest' ~ '^[0-9a-f]{64}$'
				AND hq_brought_in_at IS NOT NULL AND btrim(hq_brought_in_by) <> ''
				AND hq_refreshed_at IS NOT NULL AND btrim(hq_refreshed_by) <> '') IS TRUE
		)
	`.execute(db);

	// 3. A takeover names its person and stands only on a table with an origin.
	await sql`
		ALTER TABLE public.lookup_tables
			DROP CONSTRAINT IF EXISTS lookup_tables_hq_takeover_attributed
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_tables ADD CONSTRAINT lookup_tables_hq_takeover_attributed CHECK (
			(hq_taken_over_at IS NULL) = (hq_taken_over_by IS NULL)
			AND (hq_taken_over_at IS NULL OR hq_server IS NOT NULL)
		)
	`.execute(db);

	// 4. A Project's brought-in tables, by project space.
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_tables_hq_origin
			ON public.lookup_tables (project_id, hq_server, hq_domain) WHERE hq_server IS NOT NULL
	`.execute(db);

	// 5. An app's places' origin in CommCare HQ.
	await sql`
		ALTER TABLE public.app_organization_state
			ADD COLUMN IF NOT EXISTS hq_server text,
			ADD COLUMN IF NOT EXISTS hq_domain text,
			ADD COLUMN IF NOT EXISTS hq_places_digest text,
			ADD COLUMN IF NOT EXISTS hq_left_out jsonb,
			ADD COLUMN IF NOT EXISTS hq_brought_in_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS hq_brought_in_by text,
			ADD COLUMN IF NOT EXISTS hq_refreshed_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS hq_refreshed_by text
	`.execute(db);

	// 6. Whole or wholly absent, the second arm true and never unknown.
	await sql`
		ALTER TABLE public.app_organization_state
			DROP CONSTRAINT IF EXISTS app_organization_state_hq_origin_whole
	`.execute(db);
	await sql`
		ALTER TABLE public.app_organization_state ADD CONSTRAINT app_organization_state_hq_origin_whole CHECK (
			(hq_server IS NULL AND hq_domain IS NULL AND hq_places_digest IS NULL AND hq_left_out IS NULL
				AND hq_brought_in_at IS NULL AND hq_brought_in_by IS NULL
				AND hq_refreshed_at IS NULL AND hq_refreshed_by IS NULL)
			OR (hq_server IN ('production', 'india', 'eu')
				AND btrim(hq_domain) <> '' AND char_length(hq_domain) <= 255
				AND hq_places_digest ~ '^[0-9a-f]{64}$'
				AND jsonb_typeof(hq_left_out) = 'object'
				AND hq_brought_in_at IS NOT NULL AND btrim(hq_brought_in_by) <> ''
				AND hq_refreshed_at IS NOT NULL AND btrim(hq_refreshed_by) <> '') IS TRUE
		)
	`.execute(db);

	// 7. CommCare HQ's id of a managed place, and when a refresh kept one
	//    CommCare HQ no longer has.
	await sql`
		ALTER TABLE public.app_locations
			ADD COLUMN IF NOT EXISTS hq_location_id text
				CHECK (hq_location_id IS NULL OR btrim(hq_location_id) <> ''),
			ADD COLUMN IF NOT EXISTS hq_gone_at timestamptz(3)
	`.execute(db);

	// 8. Hand the batch back as it was found.
	await sql`SET LOCAL lock_timeout = 0`.execute(db);
}

/** Teardown only: drops the index, the three named constraints and the twenty columns. */
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP INDEX IF EXISTS public.lookup_tables_hq_origin`.execute(db);
	await sql`
		ALTER TABLE public.lookup_tables
			DROP CONSTRAINT IF EXISTS lookup_tables_hq_takeover_attributed,
			DROP CONSTRAINT IF EXISTS lookup_tables_hq_origin_whole,
			DROP COLUMN IF EXISTS hq_server,
			DROP COLUMN IF EXISTS hq_domain,
			DROP COLUMN IF EXISTS hq_remote_id,
			DROP COLUMN IF EXISTS hq_canonical,
			DROP COLUMN IF EXISTS hq_brought_in_at,
			DROP COLUMN IF EXISTS hq_brought_in_by,
			DROP COLUMN IF EXISTS hq_refreshed_at,
			DROP COLUMN IF EXISTS hq_refreshed_by,
			DROP COLUMN IF EXISTS hq_taken_over_at,
			DROP COLUMN IF EXISTS hq_taken_over_by
	`.execute(db);
	await sql`
		ALTER TABLE public.app_organization_state
			DROP CONSTRAINT IF EXISTS app_organization_state_hq_origin_whole,
			DROP COLUMN IF EXISTS hq_server,
			DROP COLUMN IF EXISTS hq_domain,
			DROP COLUMN IF EXISTS hq_places_digest,
			DROP COLUMN IF EXISTS hq_left_out,
			DROP COLUMN IF EXISTS hq_brought_in_at,
			DROP COLUMN IF EXISTS hq_brought_in_by,
			DROP COLUMN IF EXISTS hq_refreshed_at,
			DROP COLUMN IF EXISTS hq_refreshed_by
	`.execute(db);
	await sql`
		ALTER TABLE public.app_locations
			DROP COLUMN IF EXISTS hq_location_id,
			DROP COLUMN IF EXISTS hq_gone_at
	`.execute(db);
}
