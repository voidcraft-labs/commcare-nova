// CommCare stores the target case type on the index edge itself. It is the
// type captured when the relationship was written, not a live lookup of the
// target case's current type. Backfill the only historical fact Nova has (the
// target row's current type), then require every future edge to carry it.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$
		DECLARE
			cases_schema text;
			missing_count bigint;
		BEGIN
			SELECT n.nspname INTO cases_schema
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE c.oid = COALESCE(
				to_regclass('nova_case_runtime.cases'),
				to_regclass('public.cases')
			 );
			IF cases_schema IS NULL THEN
				RAISE EXCEPTION 'cases table not found in nova_case_runtime or public, the baseline migration must run first';
			END IF;

			EXECUTE 'SET LOCAL lock_timeout = ''5s''';
			EXECUTE format('LOCK TABLE %I.cases IN SHARE MODE', cases_schema);
			EXECUTE 'LOCK TABLE public.case_indices IN ACCESS EXCLUSIVE MODE';
			EXECUTE 'SET LOCAL lock_timeout = 0';

			ALTER TABLE public.case_indices
				ADD COLUMN IF NOT EXISTS target_case_type text;
			EXECUTE format(
				'UPDATE public.case_indices ci SET target_case_type = ancestor.case_type FROM %I.cases ancestor WHERE ci.ancestor_id = ancestor.case_id AND ci.target_case_type IS NULL',
				cases_schema
			);
			SELECT count(*) INTO missing_count
			  FROM public.case_indices
			 WHERE target_case_type IS NULL;
			IF missing_count <> 0 THEN
				RAISE EXCEPTION 'cannot backfill target_case_type for % case-index row(s) whose target is absent', missing_count;
			END IF;
			ALTER TABLE public.case_indices
				ALTER COLUMN target_case_type SET NOT NULL;
		END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE public.case_indices DROP COLUMN IF EXISTS target_case_type`.execute(
		db,
	);
}
