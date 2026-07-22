// Project-scoped lookup-table persistence.
//
// Lookup data is app-state data on the shared Cloud SQL database, not runtime
// case data. Stable table/column/row UUIDs decouple Nova references from the
// user-editable wire names that CommCare consumes. A Project clock provides
// level-triggered realtime invalidation; table-local definition/row revisions
// provide the optimistic-write token.
//
// The three service-maintained counters on `lookup_tables` are guarded here:
// `column_count` (1..250), `row_count` (0..5,000), and the exact sum of the
// child rows' generated `value_bytes` (0..8 MiB). Writers serialize on the
// parent table row before changing children or counters.
//
// This migration is additive and has no backfill. Forward-only in production;
// `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS lookup_project_state (
			project_id text PRIMARY KEY,
			revision bigint NOT NULL DEFAULT 0
				CHECK (revision >= 0),
			updated_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_tables (
			project_id text NOT NULL,
			id uuid NOT NULL DEFAULT uuidv7(),
			name text NOT NULL
				CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
			tag text NOT NULL
				CHECK (
					char_length(tag) BETWEEN 1 AND 32
					AND tag ~ '^[A-Za-z_][A-Za-z0-9_]*$'
					AND tag !~* '^xml'
				),
			definition_revision bigint NOT NULL
				CHECK (definition_revision >= 0),
			rows_revision bigint NOT NULL
				CHECK (rows_revision >= 0),
			column_count integer NOT NULL
				CHECK (column_count BETWEEN 1 AND 250),
			row_count integer NOT NULL DEFAULT 0
				CHECK (row_count BETWEEN 0 AND 5000),
			data_bytes integer NOT NULL DEFAULT 0
				CHECK (data_bytes BETWEEN 0 AND 8388608),
			created_by text NOT NULL,
			updated_by text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (project_id, id),
			UNIQUE (project_id, tag)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_tables_project_name_idx
			ON lookup_tables (project_id, lower(name), id)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_columns (
			project_id text NOT NULL,
			table_id uuid NOT NULL,
			id uuid NOT NULL DEFAULT uuidv7(),
			wire_name text NOT NULL
				CHECK (
					char_length(wire_name) BETWEEN 1 AND 255
					AND wire_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'
					AND wire_name !~* '^xml'
				),
			label text NOT NULL
				CHECK (char_length(label) BETWEEN 1 AND 120 AND label = btrim(label)),
			data_type text NOT NULL
				CHECK (data_type IN ('text', 'int', 'decimal', 'date', 'time', 'datetime')),
			order_key text COLLATE "C" NOT NULL
				CHECK (
					order_key ~ '^[0-9A-Za-z]+$'
					AND right(order_key, 1) <> '0'
				),
			PRIMARY KEY (project_id, table_id, id),
			UNIQUE (project_id, table_id, wire_name),
			FOREIGN KEY (project_id, table_id)
				REFERENCES lookup_tables (project_id, id)
				ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_columns_order_idx
			ON lookup_columns (project_id, table_id, order_key, id)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS lookup_rows (
			project_id text NOT NULL,
			table_id uuid NOT NULL,
			id uuid NOT NULL DEFAULT uuidv7(),
			order_key text COLLATE "C" NOT NULL
				CHECK (
					order_key ~ '^[0-9A-Za-z]+$'
					AND right(order_key, 1) <> '0'
				),
			"values" jsonb NOT NULL
				CHECK (jsonb_typeof("values") = 'object'),
			value_bytes integer GENERATED ALWAYS AS (octet_length("values"::text)) STORED
				CHECK (value_bytes BETWEEN 0 AND 262144),
			created_by text NOT NULL,
			updated_by text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (project_id, table_id, id),
			FOREIGN KEY (project_id, table_id)
				REFERENCES lookup_tables (project_id, id)
				ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS lookup_rows_order_idx
			ON lookup_rows (project_id, table_id, order_key, id)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of [
		"lookup_rows",
		"lookup_columns",
		"lookup_tables",
		"lookup_project_state",
	]) {
		await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
	}
}
