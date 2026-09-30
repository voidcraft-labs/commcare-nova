import { type Kysely, sql } from "kysely";

/** Finishing an ordered journey may follow case writes in this transaction. */
export async function up(db: Kysely<unknown>) {
	await sql`CREATE OR REPLACE FUNCTION public.nova_drop_app_test_namespace(test_id uuid)
		RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
	DECLARE
		namespace text := 'nova_app_test_' || replace(test_id::text, '-', '');
		constraint_name text;
	BEGIN
		IF test_id IS NULL THEN RAISE EXCEPTION 'A test identity is required'; END IF;
		-- DROP refuses relations with pending deferred FK events. Check those
		-- events before disposal, without changing unrelated constraint timing.
		-- Names are schema-qualified and identifier-quoted even for old clones.
		FOR constraint_name IN
			SELECT DISTINCT conname FROM pg_constraint
			WHERE connamespace = to_regnamespace(namespace) AND condeferrable
			ORDER BY conname
		LOOP
			EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', namespace, constraint_name);
		END LOOP;
		EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', namespace);
	END $$`.execute(db);
}

export async function down(db: Kysely<unknown>) {
	await sql`CREATE OR REPLACE FUNCTION public.nova_drop_app_test_namespace(test_id uuid)
		RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
	BEGIN
		IF test_id IS NULL THEN RAISE EXCEPTION 'A test identity is required'; END IF;
		EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', 'nova_app_test_' || replace(test_id::text, '-', ''));
	END $$`.execute(db);
}
