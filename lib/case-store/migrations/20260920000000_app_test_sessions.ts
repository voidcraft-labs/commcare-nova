import { type Kysely, sql } from "kysely";

/** Disposable namespaces preserve opaque case/lookup IDs without collisions
 * between tests or with real records. Clone structure only, never live rows.
 * The serving role gets no general database CREATE privilege. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE app_test_sessions (
		id uuid PRIMARY KEY,
		app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
		project_id text NOT NULL,
		created_by text NOT NULL,
		request_id text NOT NULL,
		request_digest text NOT NULL,
		blueprint_seq bigint NOT NULL,
		blueprint_digest text NOT NULL,
		runtime_version integer NOT NULL,
		snapshot jsonb NOT NULL,
		state jsonb NOT NULL,
		step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
		created_at timestamptz NOT NULL DEFAULT now(),
		expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
		disposed_at timestamptz,
		UNIQUE (app_id, created_by, request_id)
	)`.execute(db);
	await sql`CREATE TABLE app_test_steps (
		test_id uuid NOT NULL REFERENCES app_test_sessions(id) ON DELETE CASCADE,
		step integer NOT NULL CHECK (step >= 0),
		request_id text NOT NULL,
		request_digest text NOT NULL,
		action jsonb NOT NULL,
		observation jsonb NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (test_id, step),
		UNIQUE (test_id, request_id)
	)`.execute(db);
	await sql`CREATE INDEX app_test_sessions_expiry ON app_test_sessions(expires_at)
		WHERE disposed_at IS NULL`.execute(db);

	await sql`CREATE FUNCTION nova_create_app_test_namespace(test_id uuid)
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
			'lookup_rows', 'form_attachments', 'form_submission_intents'
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
	await sql`CREATE FUNCTION nova_drop_app_test_namespace(test_id uuid)
		RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
	BEGIN
		IF test_id IS NULL THEN RAISE EXCEPTION 'A test identity is required'; END IF;
		EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', 'nova_app_test_' || replace(test_id::text, '-', ''));
	END $$`.execute(db);
	await sql`REVOKE ALL ON FUNCTION nova_create_app_test_namespace(uuid), nova_drop_app_test_namespace(uuid) FROM PUBLIC`.execute(
		db,
	);
	await sql`CREATE FUNCTION nova_dispose_deleted_app_test() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
	BEGIN
		PERFORM public.nova_drop_app_test_namespace(OLD.id);
		RETURN OLD;
	END $$`.execute(db);
	await sql`REVOKE ALL ON FUNCTION nova_dispose_deleted_app_test() FROM PUBLIC`.execute(
		db,
	);
	await sql`CREATE TRIGGER app_test_session_disposal AFTER DELETE ON app_test_sessions
		FOR EACH ROW EXECUTE FUNCTION nova_dispose_deleted_app_test()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ DECLARE test record; BEGIN
		FOR test IN SELECT id FROM app_test_sessions WHERE disposed_at IS NULL LOOP
			PERFORM nova_drop_app_test_namespace(test.id);
		END LOOP;
	END $$`.execute(db);
	await sql`DROP TABLE app_test_steps, app_test_sessions`.execute(db);
	await sql`DROP FUNCTION nova_dispose_deleted_app_test(), nova_create_app_test_namespace(uuid), nova_drop_app_test_namespace(uuid)`.execute(
		db,
	);
}
