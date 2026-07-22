// Dormant lookup-reference infrastructure.
//
// S02a installs storage and rolling-compatibility guards only. No blueprint
// carrier writes reference edges yet, no destructive lookup operation is
// enabled, and no cross-Project move is admitted. The tables are nevertheless
// the final exact-set shape so later slices can activate behavior without a
// second storage transition.
//
// The writer-version guard is deliberately database-enforced. Every guarded
// statement reads and locks the singleton compatibility row FOR SHARE, so a
// floor raise linearizes with in-flight old writers: an old write that reads
// first finishes before the raise; a raise that locks first makes the writer
// wake, re-read, and fail closed. The custom GUC is transaction-local at call
// sites (`SET LOCAL nova.writer_version = '<n>'`); an unset
// value is legacy writer version 0, while malformed values are rejected.
//
// This migration is forward-only and immutable once applied. `down` exists
// solely for local/test teardown; production changes fix forward with a new
// migration.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// The composite app key is intentionally redundant with the global id PK: it
	// is the tenant-bearing parent key exact reference edges need.
	await sql`
		DO $block$
		BEGIN
			IF NOT EXISTS (
				SELECT 1
				FROM pg_constraint
				WHERE conname = 'apps_project_id_id_key'
					AND conrelid = 'apps'::regclass
			) THEN
				ALTER TABLE apps
					ADD CONSTRAINT apps_project_id_id_key UNIQUE (project_id, id);
			END IF;
		END
		$block$
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_table_references (
			project_id text NOT NULL,
			table_id uuid NOT NULL,
			app_id text NOT NULL,
			PRIMARY KEY (project_id, table_id, app_id),
			CONSTRAINT lookup_table_references_table_fk
				FOREIGN KEY (project_id, table_id)
				REFERENCES lookup_tables (project_id, id)
				ON UPDATE RESTRICT ON DELETE RESTRICT,
			CONSTRAINT lookup_table_references_app_fk
				FOREIGN KEY (project_id, app_id)
				REFERENCES apps (project_id, id)
				ON UPDATE RESTRICT ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_table_references_app_idx
			ON lookup_table_references (app_id, project_id)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_column_references (
			project_id text NOT NULL,
			table_id uuid NOT NULL,
			column_id uuid NOT NULL,
			app_id text NOT NULL,
			PRIMARY KEY (project_id, table_id, column_id, app_id),
			CONSTRAINT lookup_column_references_column_fk
				FOREIGN KEY (project_id, table_id, column_id)
				REFERENCES lookup_columns (project_id, table_id, id)
				ON UPDATE RESTRICT ON DELETE RESTRICT,
			CONSTRAINT lookup_column_references_table_edge_fk
				FOREIGN KEY (project_id, table_id, app_id)
				REFERENCES lookup_table_references (project_id, table_id, app_id)
				ON UPDATE RESTRICT ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_column_references_app_idx
			ON lookup_column_references (app_id, project_id, table_id)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_stream_capability_leases (
			app_id text NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
			connection_id uuid NOT NULL DEFAULT uuidv7(),
			receiver_version integer NOT NULL CHECK (receiver_version >= 0),
			expires_at timestamptz(3) NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (app_id, connection_id),
			CONSTRAINT lookup_stream_capability_leases_expiry_check
				CHECK (expires_at > created_at)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_stream_capability_leases_admission_idx
			ON lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_stream_capability_leases_expiry_idx
			ON lookup_stream_capability_leases (expires_at)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_stream_capability_leases_floor_drain_idx
			ON lookup_stream_capability_leases (receiver_version, expires_at)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_reference_compatibility (
			id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
			minimum_writer_version integer NOT NULL DEFAULT 0
				CHECK (minimum_writer_version >= 0),
			minimum_stream_receiver_version integer NOT NULL DEFAULT 0
				CHECK (minimum_stream_receiver_version >= 0),
			minimum_runtime_reader_version integer NOT NULL DEFAULT 0
				CHECK (minimum_runtime_reader_version >= 0),
			carrier_commits_enabled boolean NOT NULL DEFAULT false,
			destructive_schema_actions_enabled boolean NOT NULL DEFAULT false,
			project_moves_enabled boolean NOT NULL DEFAULT false,
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT lookup_reference_carrier_activation_check CHECK (
				NOT carrier_commits_enabled
				OR (
					minimum_writer_version >= 1
					AND minimum_stream_receiver_version >= 3
					AND minimum_runtime_reader_version >= 1
				)
			),
			CONSTRAINT lookup_reference_schema_activation_check CHECK (
				NOT destructive_schema_actions_enabled
				OR minimum_writer_version >= 1
			),
			CONSTRAINT lookup_reference_move_activation_check CHECK (
				NOT project_moves_enabled
				OR (
					minimum_writer_version >= 1
					AND minimum_stream_receiver_version >= 1
				)
			)
		)
	`.execute(db);
	await sql`
		INSERT INTO lookup_reference_compatibility (id)
		VALUES (1)
		ON CONFLICT (id) DO NOTHING
	`.execute(db);

	await sql`
		CREATE OR REPLACE FUNCTION nova_guard_lookup_reference_compatibility_row()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		BEGIN
			IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference compatibility state is permanent';
			END IF;

			IF NEW.minimum_writer_version < OLD.minimum_writer_version
				OR NEW.minimum_stream_receiver_version
					< OLD.minimum_stream_receiver_version
				OR NEW.minimum_runtime_reader_version
					< OLD.minimum_runtime_reader_version
			THEN
				RAISE EXCEPTION USING
					ERRCODE = '23514',
					MESSAGE = 'lookup-reference compatibility floors are monotonic';
			END IF;

			RETURN NEW;
		END
		$function$
	`.execute(db);
	await sql`
		DROP TRIGGER IF EXISTS lookup_reference_compatibility_row_guard
		ON lookup_reference_compatibility
	`.execute(db);
	await sql`
		CREATE TRIGGER lookup_reference_compatibility_row_guard
		BEFORE UPDATE OR DELETE ON lookup_reference_compatibility
		FOR EACH ROW
		EXECUTE FUNCTION nova_guard_lookup_reference_compatibility_row()
	`.execute(db);
	await sql`
		DROP TRIGGER IF EXISTS lookup_reference_compatibility_truncate_guard
		ON lookup_reference_compatibility
	`.execute(db);
	await sql`
		CREATE TRIGGER lookup_reference_compatibility_truncate_guard
		BEFORE TRUNCATE ON lookup_reference_compatibility
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_guard_lookup_reference_compatibility_row()
	`.execute(db);

	await sql`
		CREATE OR REPLACE FUNCTION nova_require_lookup_reference_writer_version()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		DECLARE
			raw_version text;
			writer_version integer;
			required_version integer;
		BEGIN
			-- PostgreSQL can retain an empty custom-setting placeholder after a
			-- transaction-local value resets. It is semantically the same as never set.
			raw_version := COALESCE(
				NULLIF(current_setting('nova.writer_version', true), ''),
				'0'
			);

			IF raw_version !~ '^(0|[1-9][0-9]*)$' THEN
				RAISE EXCEPTION USING
					ERRCODE = '22023',
					MESSAGE = 'invalid nova.writer_version';
			ELSE
				BEGIN
					writer_version := raw_version::integer;
				EXCEPTION
					WHEN numeric_value_out_of_range THEN
						RAISE EXCEPTION USING
							ERRCODE = '22023',
							MESSAGE = 'invalid nova.writer_version';
				END;
			END IF;

			SELECT compatibility.minimum_writer_version
			INTO required_version
			FROM lookup_reference_compatibility AS compatibility
			WHERE compatibility.id = 1
			FOR SHARE;

			IF NOT FOUND THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference compatibility state is missing';
			END IF;

			IF writer_version < required_version THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'lookup-reference writer version is below the database floor';
			END IF;

			RETURN NULL;
		END
		$function$
	`.execute(db);

	// Statement-level guards read the singleton once per bulk statement, not
	// once per entity row. INSERT and UPDATE OF are separate where PostgreSQL's
	// event grammar requires it.
	for (const [table, trigger] of [
		["apps", "apps_lookup_reference_writer_guard_insert"],
		["apps", "apps_lookup_reference_writer_guard_update"],
		["apps", "apps_lookup_reference_writer_guard_delete"],
		["blueprint_entities", "blueprint_entities_lookup_reference_writer_guard"],
		["accepted_mutations", "accepted_mutations_lookup_reference_writer_guard"],
		["lookup_tables", "lookup_tables_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_retype"],
	] as const) {
		await sql`DROP TRIGGER IF EXISTS ${sql.id(trigger)} ON ${sql.table(table)}`.execute(
			db,
		);
	}
	await sql`
		CREATE TRIGGER apps_lookup_reference_writer_guard_insert
		BEFORE INSERT ON apps
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	// Physical app deletion is guarded explicitly. Its FK cascades are exact and
	// need no edge rewrite, but they execute ordinary DELETE statements against
	// `blueprint_entities`; making the parent guard explicit avoids an accidental
	// trigger-depth-dependent policy.
	await sql`
		CREATE TRIGGER apps_lookup_reference_writer_guard_delete
		BEFORE DELETE ON apps
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER apps_lookup_reference_writer_guard_update
		BEFORE UPDATE OF mutation_seq, project_id ON apps
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER blueprint_entities_lookup_reference_writer_guard
		BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON blueprint_entities
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER accepted_mutations_lookup_reference_writer_guard
		BEFORE INSERT ON accepted_mutations
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER lookup_tables_reference_writer_guard_delete
		BEFORE DELETE ON lookup_tables
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER lookup_columns_reference_writer_guard_delete
		BEFORE DELETE ON lookup_columns
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
	await sql`
		CREATE TRIGGER lookup_columns_reference_writer_guard_retype
		BEFORE UPDATE OF data_type ON lookup_columns
		FOR EACH STATEMENT
		EXECUTE FUNCTION nova_require_lookup_reference_writer_version()
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Teardown only. Never run this path against a deployed database.
	for (const [table, trigger] of [
		["apps", "apps_lookup_reference_writer_guard_insert"],
		["apps", "apps_lookup_reference_writer_guard_update"],
		["apps", "apps_lookup_reference_writer_guard_delete"],
		["blueprint_entities", "blueprint_entities_lookup_reference_writer_guard"],
		["accepted_mutations", "accepted_mutations_lookup_reference_writer_guard"],
		["lookup_tables", "lookup_tables_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_delete"],
		["lookup_columns", "lookup_columns_reference_writer_guard_retype"],
	] as const) {
		await sql`DROP TRIGGER IF EXISTS ${sql.id(trigger)} ON ${sql.table(table)}`.execute(
			db,
		);
	}

	await sql`
		DROP TRIGGER IF EXISTS lookup_reference_compatibility_truncate_guard
		ON lookup_reference_compatibility
	`.execute(db);
	await sql`
		DROP TRIGGER IF EXISTS lookup_reference_compatibility_row_guard
		ON lookup_reference_compatibility
	`.execute(db);
	await sql`DROP FUNCTION IF EXISTS nova_require_lookup_reference_writer_version()`.execute(
		db,
	);
	await sql`DROP FUNCTION IF EXISTS nova_guard_lookup_reference_compatibility_row()`.execute(
		db,
	);

	for (const table of [
		"lookup_column_references",
		"lookup_table_references",
		"lookup_stream_capability_leases",
		"lookup_reference_compatibility",
	]) {
		await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
	}

	await sql`
		ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_project_id_id_key
	`.execute(db);
}
