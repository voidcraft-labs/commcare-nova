import { type Kysely, sql } from "kysely";

const ordinaryTables = [
	"lookup_project_edit_receipts",
	"lookup_authoring_receipts",
	"lookup_member_references",
	"lookup_table_references",
	"lookup_column_references",
	"lookup_tables",
	"lookup_rows",
	"lookup_columns",
	"lookup_members",
] as const;
const generationTables = [
	"lookup_generations",
	"lookup_generation_pages",
	"lookup_generation_rows",
	"lookup_generation_blobs",
	"lookup_generation_chunks",
] as const;

/** Charge a deterministic upper bound on stored payload, row headers and indexes.
 * Do not charge TOAST pointer length: a row can hold externally stored bytes. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE lookup_storage_budgets (
		project_id text PRIMARY KEY,
		capacity_bytes bigint NOT NULL DEFAULT 34359738368 CHECK (capacity_bytes > 0),
		used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
		bulk_slots integer NOT NULL DEFAULT 2 CHECK (bulk_slots > 0)
	)`.execute(db);
	await sql`ALTER TABLE lookup_tables
		DROP CONSTRAINT lookup_tables_row_count_check, ADD CHECK (row_count >= 0),
		DROP CONSTRAINT lookup_tables_column_count_check, ADD CHECK (column_count >= 0),
		DROP CONSTRAINT lookup_tables_data_bytes_check, ALTER COLUMN data_bytes TYPE bigint,
		ADD CHECK (data_bytes >= 0),
		ADD COLUMN active_generation_id uuid`.execute(db);
	await sql`ALTER TABLE lookup_rows DROP CONSTRAINT lookup_rows_value_bytes_check`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_generations (
		project_id text NOT NULL, table_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuidv7(),
		actor_id text NOT NULL, runner_id uuid NOT NULL, lease_until timestamptz NOT NULL,
		scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
		definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
		expected_revision bigint NOT NULL,
		state text NOT NULL CHECK (state IN ('staging','paused','complete','retired')),
		next_ordinal bigint NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
		through_digest text NOT NULL CHECK (through_digest ~ '^[0-9a-f]{64}$'),
		payload_bytes bigint NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
		started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
		expires_at timestamptz NOT NULL,
		PRIMARY KEY (project_id,table_id,id),
		FOREIGN KEY (project_id,table_id) REFERENCES lookup_tables(project_id,id) ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE UNIQUE INDEX lookup_generations_staging_scope
		ON lookup_generations(project_id,table_id,actor_id,scope_digest) WHERE state IN ('staging','paused')`.execute(
		db,
	);
	await sql`CREATE INDEX lookup_generations_cleanup ON lookup_generations(project_id,state,expires_at)`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_tables ADD FOREIGN KEY (project_id,id,active_generation_id)
		REFERENCES lookup_generations(project_id,table_id,id) DEFERRABLE INITIALLY DEFERRED`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_generation_pages (
		project_id text NOT NULL, table_id uuid NOT NULL, generation_id uuid NOT NULL,
		first_ordinal bigint NOT NULL CHECK (first_ordinal >= 0),
		end_ordinal bigint NOT NULL CHECK (end_ordinal > first_ordinal),
		page_digest text NOT NULL CHECK (page_digest ~ '^[0-9a-f]{64}$'),
		through_digest text NOT NULL CHECK (through_digest ~ '^[0-9a-f]{64}$'),
		PRIMARY KEY(project_id,table_id,generation_id,first_ordinal),
		FOREIGN KEY(project_id,table_id,generation_id) REFERENCES lookup_generations ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE TABLE lookup_generation_rows (
		project_id text NOT NULL, table_id uuid NOT NULL, generation_id uuid NOT NULL,
		ordinal bigint NOT NULL CHECK (ordinal >= 0), row_id uuid NOT NULL,
		source_id text NOT NULL CHECK (source_id ~ '^[0-9a-f]{32}$'),
		byte_length bigint NOT NULL CHECK (byte_length > 0),
		PRIMARY KEY(project_id,table_id,generation_id,ordinal),
		UNIQUE(project_id,table_id,generation_id,source_id),
		UNIQUE(project_id,table_id,generation_id,row_id),
		FOREIGN KEY(project_id,table_id,generation_id) REFERENCES lookup_generations ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE TABLE lookup_generation_blobs(
		project_id text NOT NULL,id text NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),body bytea NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 32768),
		CHECK(id=encode(sha256(body),'hex')),PRIMARY KEY(project_id,id)
	)`.execute(db);
	await sql`CREATE TABLE lookup_generation_chunks (
		project_id text NOT NULL, table_id uuid NOT NULL, generation_id uuid NOT NULL,
		ordinal bigint NOT NULL, byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
		blob_id text NOT NULL,
		FOREIGN KEY(project_id,blob_id) REFERENCES lookup_generation_blobs(project_id,id) ON DELETE RESTRICT,
		PRIMARY KEY(project_id,table_id,generation_id,ordinal,byte_offset),
		FOREIGN KEY(project_id,table_id,generation_id,ordinal) REFERENCES lookup_generation_rows ON DELETE CASCADE
	)`.execute(db);

	await sql`CREATE INDEX lookup_generation_chunks_blob ON lookup_generation_chunks(project_id,blob_id)`.execute(
		db,
	);

	// Use the same wire-length measurement for OLD and NEW (including pre-migration
	// rows). The per-row allowance covers tuple headers, deterministic indexes and
	// TOAST metadata. Value/metadata changes settle on their own SQL transaction.
	for (const table of ordinaryTables) {
		await sql`INSERT INTO lookup_storage_budgets(project_id,used_bytes)
			SELECT project_id, sum(512 + octet_length(to_jsonb(r)::text)) FROM ${sql.table(table)} r GROUP BY project_id
			ON CONFLICT(project_id) DO UPDATE SET used_bytes = lookup_storage_budgets.used_bytes + excluded.used_bytes`.execute(
			db,
		);
	}
	// The serving revision writes the tables this trigger fires on before
	// convergence grants it the ledger this migration creates, so the function
	// writes that ledger as its owner, through schema-qualified names only.
	await sql`CREATE FUNCTION nova_account_lookup_storage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
	DECLARE
		old_bytes bigint := 0; new_bytes bigint := 0; tenant text;
	BEGIN
		IF TG_OP <> 'INSERT' THEN
			tenant := OLD.project_id;
			IF TG_TABLE_NAME IN ('lookup_generation_blobs','lookup_cell_blobs','lookup_cell_inputs') THEN
				old_bytes := 512 + octet_length(OLD.project_id) + octet_length(OLD.body);
			ELSE
				old_bytes := 512 + octet_length((to_jsonb(OLD)-'external_bytes')::text);
			END IF;
		END IF;
		IF TG_OP <> 'DELETE' THEN
			IF tenant IS NOT NULL AND tenant <> NEW.project_id THEN
				RAISE EXCEPTION 'Lookup storage cannot change Project.';
			END IF;
			tenant := NEW.project_id;
			IF TG_TABLE_NAME IN ('lookup_generation_blobs','lookup_cell_blobs','lookup_cell_inputs') THEN
				new_bytes := 512 + octet_length(NEW.project_id) + octet_length(NEW.body);
			ELSE
				new_bytes := 512 + octet_length((to_jsonb(NEW)-'external_bytes')::text);
			END IF;
		END IF;
		IF new_bytes = old_bytes THEN RETURN NULL; END IF;
		INSERT INTO public.lookup_storage_budgets(project_id) VALUES (tenant) ON CONFLICT DO NOTHING;
		UPDATE public.lookup_storage_budgets SET used_bytes = used_bytes + new_bytes - old_bytes
			WHERE project_id = tenant AND (new_bytes <= old_bytes OR
				used_bytes + new_bytes - old_bytes <= capacity_bytes - CASE WHEN current_setting('nova.lookup_rewrite_project',true)=tenant THEN 0 ELSE least(capacity_bytes / 32, 67108864) END);
		IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', CONSTRAINT='lookup_storage_capacity',
			MESSAGE='This Project needs more storage for this change. You can free space or keep the source reference.'; END IF;
		RETURN NULL;
	END $$`.execute(db);
	for (const table of [...ordinaryTables, ...generationTables]) {
		await sql`CREATE TRIGGER nova_account_lookup_storage AFTER INSERT OR UPDATE OR DELETE
			ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION nova_account_lookup_storage()`.execute(
			db,
		);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM lookup_generations)
		OR EXISTS (SELECT 1 FROM lookup_tables WHERE row_count > 5000 OR column_count > 250 OR data_bytes > 8388608)
		OR EXISTS (SELECT 1 FROM lookup_rows WHERE value_bytes > 262144)
		THEN RAISE EXCEPTION 'Restore from the reviewed lookup storage backup.'; END IF; END $$`.execute(
		db,
	);
	for (const table of [...ordinaryTables, ...generationTables]) {
		await sql`DROP TRIGGER nova_account_lookup_storage ON ${sql.table(table)}`.execute(
			db,
		);
	}
	await sql`DROP FUNCTION nova_account_lookup_storage()`.execute(db);
	await sql`ALTER TABLE lookup_tables DROP COLUMN active_generation_id,
		DROP CONSTRAINT lookup_tables_row_count_check, ADD CHECK (row_count BETWEEN 0 AND 5000),
		DROP CONSTRAINT lookup_tables_column_count_check, ADD CHECK (column_count BETWEEN 0 AND 250),
		DROP CONSTRAINT lookup_tables_data_bytes_check, ALTER COLUMN data_bytes TYPE integer,
		ADD CHECK (data_bytes BETWEEN 0 AND 8388608)`.execute(db);
	await sql`ALTER TABLE lookup_rows ADD CHECK (value_bytes BETWEEN 0 AND 262144)`.execute(
		db,
	);
	for (const table of [...generationTables].reverse()) {
		await sql`DROP TABLE ${sql.table(table)}`.execute(db);
	}
	await sql`DROP TABLE lookup_storage_budgets`.execute(db);
}
