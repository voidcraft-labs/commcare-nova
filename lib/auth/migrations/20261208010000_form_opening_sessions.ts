import { type Kysely, sql } from "kysely";

/** Both ledgers can run first in a fresh installation. A deleted sign-in
 * retires any form opening still attached to it. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$
	BEGIN
		IF to_regclass('public.form_opening_data') IS NOT NULL
			AND to_regclass('public.auth_session') IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
				WHERE conrelid = to_regclass('public.form_opening_data') AND conname = 'form_opening_data_session_fk') THEN
			ALTER TABLE public.form_opening_data ADD CONSTRAINT form_opening_data_session_fk
				FOREIGN KEY (session_id) REFERENCES public.auth_session(id) ON DELETE CASCADE;
		END IF;
	END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE IF EXISTS public.form_opening_data DROP CONSTRAINT IF EXISTS form_opening_data_session_fk`.execute(
		db,
	);
}
