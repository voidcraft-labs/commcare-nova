import { type Kysely, sql } from "kysely";

const relations = [
	"lookup_bulk_reservations",
	"lookup_cell_values",
	"lookup_cell_value_refs",
	"lookup_cell_blobs",
	"lookup_cell_segments",
	"lookup_cell_edits",
	"lookup_cell_inputs",
] as const;
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE lookup_bulk_reservations (
		project_id text NOT NULL, object_id uuid NOT NULL, actor_id text NOT NULL, binding text NOT NULL,
		kind text NOT NULL, state text NOT NULL CHECK (state IN ('working','stored','deleting')),
		bytes bigint NOT NULL DEFAULT 0 CHECK (bytes>=0), expires_at timestamptz NOT NULL,
		PRIMARY KEY(project_id,object_id)
	)`.execute(db);
	await sql`CREATE INDEX lookup_bulk_work ON lookup_bulk_reservations(project_id,state,expires_at)`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_rows ADD COLUMN external_bytes bigint NOT NULL DEFAULT 0 CHECK(external_bytes>=0)`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_cell_values(
		project_id text NOT NULL,id uuid NOT NULL DEFAULT uuidv7(),
		PRIMARY KEY(project_id,id)
	)`.execute(db);
	await sql`CREATE TABLE lookup_cell_value_refs (
		project_id text NOT NULL,table_id uuid NOT NULL,row_id uuid NOT NULL,slot text[] NOT NULL,
		value_id uuid NOT NULL,total_bytes bigint NOT NULL CHECK (total_bytes>=0),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
		UNIQUE(project_id,table_id,row_id,slot) DEFERRABLE INITIALLY DEFERRED,
		CHECK ((slot[1] IN ('cell','attribute') AND cardinality(slot)=2) OR
			(slot[1]='occurrence' AND cardinality(slot)=3) OR (slot[1]='property' AND cardinality(slot)=4)),
		FOREIGN KEY(project_id,table_id,row_id) REFERENCES lookup_rows ON DELETE CASCADE,
		FOREIGN KEY(project_id,value_id) REFERENCES lookup_cell_values ON DELETE RESTRICT
	)`.execute(db);
	await sql`CREATE INDEX lookup_cell_refs_value ON lookup_cell_value_refs(project_id,value_id)`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_cell_blobs(
		project_id text NOT NULL,id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'),body bytea NOT NULL,
		CHECK (octet_length(body) BETWEEN 1 AND 32768),CHECK(id=encode(sha256(body),'hex')),PRIMARY KEY(project_id,id)
	)`.execute(db);
	await sql`CREATE TABLE lookup_cell_segments(
		project_id text NOT NULL,value_id uuid NOT NULL,byte_offset bigint NOT NULL CHECK(byte_offset>=0),
		char_offset bigint NOT NULL CHECK(char_offset>=0),byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 32768),
		blob_id text NOT NULL,PRIMARY KEY(project_id,value_id,byte_offset),
		FOREIGN KEY(project_id,value_id) REFERENCES lookup_cell_values ON DELETE CASCADE,
		FOREIGN KEY(project_id,blob_id) REFERENCES lookup_cell_blobs ON DELETE RESTRICT
	)`.execute(db);
	await sql`CREATE INDEX lookup_cell_segments_blob ON lookup_cell_segments(project_id,blob_id)`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_cell_edits(
		project_id text NOT NULL,table_id uuid NOT NULL,actor_id text NOT NULL,id uuid NOT NULL,
		row_id uuid NOT NULL,slot text[] NOT NULL,binding text NOT NULL,review_digest text NOT NULL,
		expected_revision bigint NOT NULL,base_digest text NOT NULL,base_bytes bigint NOT NULL CHECK(base_bytes>=0),
		start_byte bigint NOT NULL CHECK(start_byte>=0),end_byte bigint NOT NULL CHECK (end_byte>=start_byte AND end_byte<=base_bytes),
		replacement_bytes bigint NOT NULL CHECK(replacement_bytes>=0),replacement_digest text NOT NULL,
		next_offset bigint NOT NULL DEFAULT 0 CHECK(next_offset BETWEEN 0 AND replacement_bytes),
		state text NOT NULL CHECK(state IN ('staging','complete','cancelled')),result_revision bigint,expires_at timestamptz NOT NULL,
		PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,table_id) REFERENCES lookup_tables ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE INDEX lookup_cell_edits_recovery ON lookup_cell_edits(project_id,state,expires_at)`.execute(
		db,
	);
	await sql`CREATE TABLE lookup_cell_inputs(
		project_id text NOT NULL,operation_id uuid NOT NULL,byte_offset bigint NOT NULL CHECK(byte_offset>=0),
		body bytea NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 32768),PRIMARY KEY(project_id,operation_id,byte_offset),
		FOREIGN KEY(project_id,operation_id) REFERENCES lookup_cell_edits ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE FUNCTION nova_set_lookup_external_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
	DECLARE delta bigint := 0; p text; t uuid; r uuid;
	BEGIN
		IF TG_OP <> 'INSERT' THEN delta := -OLD.total_bytes; p:=OLD.project_id; t:=OLD.table_id; r:=OLD.row_id; END IF;
		IF TG_OP <> 'DELETE' THEN delta := delta + NEW.total_bytes; p:=NEW.project_id; t:=NEW.table_id; r:=NEW.row_id; END IF;
		IF delta <> 0 THEN UPDATE public.lookup_rows SET external_bytes=external_bytes+delta WHERE project_id=p AND table_id=t AND id=r; END IF;
		RETURN NULL;
	END $$`.execute(db);
	await sql`CREATE TRIGGER nova_set_lookup_external_bytes AFTER INSERT OR UPDATE OR DELETE ON lookup_cell_value_refs
		FOR EACH ROW EXECUTE FUNCTION nova_set_lookup_external_bytes()`.execute(db);
	for (const relation of relations)
		await sql`CREATE TRIGGER nova_account_lookup_storage AFTER INSERT OR UPDATE OR DELETE
		ON ${sql.table(relation)} FOR EACH ROW EXECUTE FUNCTION nova_account_lookup_storage()`.execute(
			db,
		);
}
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM lookup_cell_value_refs) OR EXISTS (SELECT 1 FROM lookup_cell_edits)
		OR EXISTS (SELECT 1 FROM lookup_bulk_reservations) THEN RAISE EXCEPTION 'Restore the verified lookup storage backup.'; END IF; END $$`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_rows DROP COLUMN external_bytes`.execute(db);
	for (const table of [...relations].reverse())
		await sql`DROP TABLE ${sql.table(table)}`.execute(db);
	await sql`DROP FUNCTION nova_set_lookup_external_bytes()`.execute(db);
}
