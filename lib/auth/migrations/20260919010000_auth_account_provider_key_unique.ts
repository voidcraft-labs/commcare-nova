// Nova-owned UNIQUE index on Better Auth's `auth_account` — the account key.
//
// Better Auth finds an account by ("providerId", "accountId") and refuses the
// sign-in when that pair matches more than one row ("Multiple accounts
// match…"), which locks the person out until a row is removed by hand. Its own
// schema carries no unique index on the pair, so nothing at the database level
// stops a second row: two OAuth callbacks for one new person racing each other,
// or a revision that keys accounts differently inserting beside an existing
// row. This index makes the duplicate impossible; the losing insert fails and
// that one sign-in is retried instead.
//
// Runs AFTER Better Auth's own migrator (which creates `auth_account`) via the
// auth-app migrator (lib/auth/migrate.ts). `IF NOT EXISTS` so it self-adopts.
// A unique build cannot choose between two existing rows, so duplicates are
// reported by name first rather than left to Postgres's index-build error.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		DO $$
		DECLARE
			duplicated text;
		BEGIN
			SELECT string_agg(format('%s / %s (%s rows)', "providerId", "accountId", copies), ', ')
			INTO duplicated
			FROM (
				SELECT "providerId", "accountId", count(*) AS copies
				FROM public.auth_account
				GROUP BY "providerId", "accountId"
				HAVING count(*) > 1
				ORDER BY "providerId", "accountId"
				LIMIT 20
			) AS repeated;
			IF duplicated IS NOT NULL THEN
				RAISE EXCEPTION 'auth_account holds more than one row for the same sign-in identity: %. Better Auth already refuses these people at sign-in. Keep the row each person actually signs in with, remove the others, and run the migration again.', duplicated;
			END IF;
		END
		$$
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS auth_account_provider_account_unique
		ON public.auth_account ("providerId", "accountId")
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		DROP INDEX IF EXISTS public.auth_account_provider_account_unique
	`.execute(db);
}
