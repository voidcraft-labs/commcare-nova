import { type Kysely, sql } from "kysely";

/** Keep lookup submission locks inside each disposable namespace.
 * CREATE OR REPLACE preserves the routine owner and existing execute ACL. */
async function replaceCreation(
	db: Kysely<unknown>,
	includeLookupTables: boolean,
) {
	await sql`CREATE OR REPLACE FUNCTION public.nova_create_app_test_namespace(test_id uuid)
		RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
	DECLARE
		namespace text := 'nova_app_test_' || replace(test_id::text, '-', '');
		invoker name := CASE WHEN current_setting('role') = 'none' THEN session_user ELSE current_setting('role') END;
		table_name text;
		source_table regclass;
		constraint_row record;
	BEGIN
		IF test_id IS NULL THEN RAISE EXCEPTION 'A test identity is required'; END IF;
		EXECUTE format('CREATE SCHEMA %I', namespace);
		FOREACH table_name IN ARRAY ARRAY[
			'apps', 'app_locations', 'cases', 'case_type_schemas',
			'case_schema_index_deletions', 'case_indices', 'parked_case_values',
			'lookup_rows', 'form_attachments', 'form_submission_intents'${sql.raw(includeLookupTables ? " , 'lookup_tables'" : "")}
		] LOOP
			source_table := CASE WHEN table_name = 'cases'
				THEN coalesce(to_regclass('nova_case_runtime.cases'), to_regclass('public.cases'))
				ELSE to_regclass(format('public.%I', table_name)) END;
			IF source_table IS NULL THEN RAISE EXCEPTION 'Missing test source table %', table_name; END IF;
			EXECUTE format('CREATE TABLE %I.%I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING STORAGE)', namespace, table_name, source_table);
			-- Copy identity constraints, not app-specific expression indexes or
			-- foreign keys/triggers pointing back at live application tables.
			FOR constraint_row IN SELECT conname, pg_get_constraintdef(oid) AS definition
				FROM pg_constraint WHERE conrelid = source_table AND contype IN ('p', 'u')
			LOOP
				EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', namespace, table_name, constraint_row.conname, constraint_row.definition);
			END LOOP;
		END LOOP;
		-- Preserve foreign keys wholly inside the isolated relation graph.
		-- External app-state identities are authorized and pinned by the host;
		-- no cloned relation may cascade into a live table.
		FOR constraint_row IN
			SELECT c.conname, source.relname AS source_name, target.relname AS target_name,
				(SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY key.ordinality)
				 FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
				 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum) AS source_columns,
				(SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY key.ordinality)
				 FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality)
				 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum) AS target_columns,
				CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
				CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
				CASE c.confmatchtype WHEN 'f' THEN 'FULL' WHEN 'p' THEN 'PARTIAL' ELSE 'SIMPLE' END AS match_type,
				CASE WHEN c.condeferrable THEN 'DEFERRABLE' ELSE 'NOT DEFERRABLE' END AS deferrable,
				CASE WHEN c.condeferred THEN 'INITIALLY DEFERRED' ELSE 'INITIALLY IMMEDIATE' END AS initially
			FROM pg_constraint c JOIN pg_class source ON source.oid = c.conrelid
			JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
			JOIN pg_class target ON target.oid = c.confrelid
			JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
			WHERE c.contype = 'f' AND source_ns.nspname IN ('public', 'nova_case_runtime')
				AND target_ns.nspname IN ('public', 'nova_case_runtime')
				AND to_regclass(format('%I.%I', namespace, source.relname)) IS NOT NULL
				AND to_regclass(format('%I.%I', namespace, target.relname)) IS NOT NULL
		LOOP
			EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I.%I (%s) MATCH %s ON UPDATE %s ON DELETE %s %s %s',
				namespace, constraint_row.source_name, constraint_row.conname, constraint_row.source_columns,
				namespace, constraint_row.target_name, constraint_row.target_columns, constraint_row.match_type,
				constraint_row.on_update, constraint_row.on_delete, constraint_row.deferrable, constraint_row.initially);
		END LOOP;
		EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', namespace, invoker);
		EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', namespace, invoker);
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', namespace, invoker);
		RETURN namespace;
	END $$`.execute(db);
}

export async function up(db: Kysely<unknown>) {
	await replaceCreation(db, true);
}

export async function down(db: Kysely<unknown>) {
	await replaceCreation(db, false);
}
