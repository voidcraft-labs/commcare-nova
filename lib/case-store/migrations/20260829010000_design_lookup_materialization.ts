// Reviewed-design Project-data materialization.
//
// A clean accepted Design Contract may declare Project lookup tables before
// the app exists. The immutable receipt binds that accepted revision to the
// exact Project revision and DesignId -> lookup UUID mapping produced by one
// atomic write. Temporary table/column protection rows close the otherwise
// unsafe interval between that write and sequence-one app genesis; canonical
// lookup-reference edges take over in the genesis transaction.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE design_lookup_materializations (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			design_revision_id uuid NOT NULL
				REFERENCES design_revisions(id),
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			project_id text NOT NULL,
			project_revision bigint NOT NULL CHECK (project_revision >= 0),
			result_digest text NOT NULL
				CHECK (result_digest ~ ${sql.raw(SHA256_HEX)}),
			mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_lookup_materializations_revision_unique
				UNIQUE (design_revision_id),
			CONSTRAINT design_lookup_materializations_session_revision_unique
				UNIQUE (design_session_id, design_revision_id)
		)
	`.execute(db);

	await sql`
		CREATE TABLE design_lookup_protections (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			materialization_id uuid NOT NULL
				REFERENCES design_lookup_materializations(id) ON DELETE CASCADE,
			project_id text NOT NULL,
			table_id uuid NOT NULL,
			column_id uuid,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			UNIQUE NULLS NOT DISTINCT (materialization_id, table_id, column_id),
			FOREIGN KEY (project_id, table_id)
				REFERENCES lookup_tables(project_id, id),
			FOREIGN KEY (project_id, table_id, column_id)
				REFERENCES lookup_columns(project_id, table_id, id)
		)
	`.execute(db);
	await sql`
		CREATE INDEX design_lookup_protections_table_idx
			ON design_lookup_protections(project_id, table_id)
	`.execute(db);
	await sql`
		CREATE INDEX design_lookup_protections_column_idx
			ON design_lookup_protections(project_id, table_id, column_id)
			WHERE column_id IS NOT NULL
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_lookup_protections`.execute(db);
	await sql`DROP TABLE IF EXISTS design_lookup_materializations`.execute(db);
}
