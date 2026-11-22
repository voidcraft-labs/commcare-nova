import { type Kysely, sql } from "kysely";

/** Existing cells keep their original spelling, shape and byte count. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE lookup_tables ADD COLUMN hq_source_observation jsonb
		CHECK (hq_source_observation IS NULL OR (jsonb_typeof(hq_source_observation) = 'object'
			AND octet_length(hq_source_observation::text) <= 4194304 AND hq_server IS NOT NULL))`.execute(
		db,
	);

	await sql`ALTER TABLE lookup_columns
		ADD COLUMN repeated boolean NOT NULL DEFAULT false,
		ADD COLUMN index_status text NOT NULL DEFAULT 'off'
			CHECK (index_status IN ('off', 'indexed', 'unobserved')),
		ADD CHECK (NOT repeated OR data_type = 'text')`.execute(db);
	// A pre-existing API copy supplied no index observations. A takeover kept
	// that copy; it cannot certify that its original source had no index.
	await sql`UPDATE lookup_columns AS c SET index_status = 'unobserved'
		FROM lookup_tables AS t WHERE t.hq_server IS NOT NULL
		AND (t.project_id, t.id) = (c.project_id, c.table_id)`.execute(db);
	await sql`CREATE TABLE lookup_members (
		project_id text NOT NULL, table_id uuid NOT NULL, column_id uuid,
		id uuid NOT NULL DEFAULT uuidv7(),
		wire_name text NOT NULL CONSTRAINT lookup_members_xmlns_reserved CHECK (wire_name <> 'xmlns'),
		label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120 AND label = btrim(label)),
		position integer NOT NULL CHECK (position >= 0),
		PRIMARY KEY (project_id, table_id, id),
		UNIQUE NULLS NOT DISTINCT (project_id, table_id, column_id, wire_name) DEFERRABLE INITIALLY DEFERRED,
		FOREIGN KEY (project_id, table_id) REFERENCES lookup_tables (project_id, id) ON DELETE CASCADE,
		FOREIGN KEY (project_id, table_id, column_id) REFERENCES lookup_columns (project_id, table_id, id) ON DELETE CASCADE
	)`.execute(db);
	// Members use the same exact XML name repertoire as lookup columns. The
	// migration that admitted those names owns PostgreSQL's collation and ranges.
	await sql`DO $$ DECLARE name_check text; BEGIN
		SELECT pg_get_constraintdef(oid) INTO STRICT name_check FROM pg_constraint
			WHERE conrelid = 'lookup_columns'::regclass AND conname = 'lookup_columns_wire_name_check';
		EXECUTE format('ALTER TABLE lookup_members ADD CONSTRAINT lookup_members_wire_name_check %s', name_check);
	END $$`.execute(db);
	await sql`ALTER TABLE lookup_authoring_receipts ADD COLUMN required_capability text CHECK (required_capability IN ('edit','delete'))`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_project_edit_receipts (
		project_id text NOT NULL, actor_id text NOT NULL, operation_id uuid NOT NULL, required_capability text NOT NULL CHECK (required_capability IN ('edit','delete')),
		digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
		receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'), created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (project_id,actor_id,operation_id)
	)`.execute(db);
	await sql`CREATE TABLE lookup_member_references (
		project_id text NOT NULL, table_id uuid NOT NULL, member_id uuid NOT NULL, app_id text NOT NULL,
		PRIMARY KEY (project_id, table_id, member_id, app_id),
		FOREIGN KEY (project_id, table_id, member_id) REFERENCES lookup_members(project_id, table_id, id) ON DELETE RESTRICT,
		FOREIGN KEY (project_id, table_id, app_id) REFERENCES lookup_table_references(project_id, table_id, app_id) ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE INDEX lookup_member_references_app_idx ON lookup_member_references(app_id,project_id)`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_tables DROP CONSTRAINT lookup_tables_column_count_check,
		ADD CHECK (column_count BETWEEN 0 AND 250)`.execute(db);
	await sql`ALTER TABLE lookup_rows ADD COLUMN hq_row_id text, ADD COLUMN hq_sort_key integer, ADD COLUMN content jsonb NOT NULL DEFAULT '{}'
		CHECK (jsonb_typeof(content) = 'object')`.execute(db);
	await sql`CREATE UNIQUE INDEX lookup_rows_source_id ON lookup_rows(project_id,table_id,hq_row_id) WHERE hq_row_id IS NOT NULL`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_rows ALTER COLUMN value_bytes SET EXPRESSION AS (
		octet_length("values"::text) + CASE WHEN content = '{}'::jsonb THEN 0 ELSE octet_length(content::text) END
	)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM lookup_tables WHERE hq_source_observation IS NOT NULL)
		THEN RAISE EXCEPTION 'A selected workbook observation requires the recorded restore point.'; END IF; END $$`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_tables DROP COLUMN hq_source_observation`.execute(
		db,
	);

	// A rollback may drop derived "unobserved" on old scalar managed copies.
	// All user-created structure and row bytes require a compatible restore.
	await sql`DO $$ BEGIN
		IF EXISTS (SELECT 1 FROM lookup_project_edit_receipts)
			OR EXISTS (SELECT 1 FROM lookup_members)
			OR EXISTS (SELECT 1 FROM lookup_columns WHERE repeated OR index_status = 'indexed')
			OR EXISTS (SELECT 1 FROM lookup_rows WHERE content <> '{}' OR hq_row_id IS NOT NULL OR hq_sort_key IS NOT NULL)
			OR EXISTS (SELECT 1 FROM lookup_tables WHERE column_count = 0)
		THEN RAISE EXCEPTION 'Rich lookup data requires a compatible restore before rollback.'; END IF;
	END $$`.execute(db);
	await sql`ALTER TABLE lookup_rows ALTER COLUMN value_bytes SET EXPRESSION AS (octet_length("values"::text))`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_rows DROP COLUMN content, DROP COLUMN hq_row_id, DROP COLUMN hq_sort_key`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_authoring_receipts DROP COLUMN required_capability`.execute(
		db,
	);
	await sql`DROP TABLE lookup_project_edit_receipts`.execute(db);
	await sql`DROP TABLE lookup_member_references`.execute(db);
	await sql`DROP TABLE lookup_members`.execute(db);
	await sql`ALTER TABLE lookup_tables DROP CONSTRAINT lookup_tables_column_count_check, ADD CHECK (column_count BETWEEN 1 AND 250)`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_columns DROP COLUMN repeated, DROP COLUMN index_status`.execute(
		db,
	);
}
