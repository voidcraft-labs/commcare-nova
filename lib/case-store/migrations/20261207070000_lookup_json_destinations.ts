import { type Kysely, sql } from "kysely";

/**
 * The destination ledger of CommCare HQ's JSON lookup resources, and the
 * journal of every write Nova sends through them
 * (`lib/deployment/lookupJsonLedger.ts`).
 *
 * A destination is one Nova table on one project space, shared by every app
 * of the Project that publishes it there: the remote table id CommCare HQ
 * gave it, the tag it was made under (HQ refuses a tag change), the digest of
 * the definition Nova last wrote, and a revision every acknowledged write
 * moves. Each destination row maps one Nova row UUID to the row id CommCare
 * HQ minted for it, with the rank and content digest Nova last wrote; a
 * remote row id belongs to at most one Nova row of a Project on that project
 * space. The journal holds one entry per request, written before it is sent
 * under the Project's lookup fence, and at most one entry per destination is
 * open (admitted, uncertain or held for review) at a time, which is what
 * serializes every publisher of that table across the Project's apps.
 *
 * Additive: new tables, plus `lookup-json` among the write kinds a lookup
 * table's remote write may name. The revision serving while this runs never
 * reads the new tables and never writes the new kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE public.lookup_json_destinations (
			project_id text NOT NULL,
			server text NOT NULL CHECK (btrim(server) <> ''),
			domain text NOT NULL CHECK (btrim(domain) <> ''),
			table_id uuid NOT NULL,
			tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 32),
			remote_table_id text CHECK (remote_table_id ~ '^[a-f0-9]{32}$'),
			definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			created_by text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (project_id, server, domain, table_id),
			UNIQUE (project_id, server, domain, remote_table_id),
			FOREIGN KEY (project_id, table_id)
				REFERENCES public.lookup_tables (project_id, id) ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE TABLE public.lookup_json_destination_rows (
			project_id text NOT NULL,
			server text NOT NULL,
			domain text NOT NULL,
			table_id uuid NOT NULL,
			row_id uuid NOT NULL,
			remote_row_id text NOT NULL CHECK (remote_row_id ~ '^[a-f0-9]{32}$'),
			sort_key integer NOT NULL,
			digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
			PRIMARY KEY (project_id, server, domain, table_id, row_id),
			UNIQUE (project_id, server, domain, remote_row_id),
			FOREIGN KEY (project_id, server, domain, table_id)
				REFERENCES public.lookup_json_destinations (project_id, server, domain, table_id)
				ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE TABLE public.lookup_json_operations (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			project_id text NOT NULL,
			server text NOT NULL,
			domain text NOT NULL,
			table_id uuid NOT NULL,
			app_id text NOT NULL,
			actor_user_id text NOT NULL,
			kind text NOT NULL
				CHECK (kind IN ('create-table', 'create-row', 'update-row', 'delete-row')),
			row_id uuid,
			remote_id text CHECK (remote_id ~ '^[a-f0-9]{32}$'),
			intended jsonb NOT NULL CHECK (jsonb_typeof(intended) = 'object'),
			before jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
			state text NOT NULL
				CHECK (state IN ('admitted', 'applied', 'not-applied', 'uncertain', 'review')),
			result_remote_id text CHECK (result_remote_id ~ '^[a-f0-9]{32}$'),
			admitted_at timestamptz(3) NOT NULL DEFAULT now(),
			settled_at timestamptz(3),
			CONSTRAINT lookup_json_operations_row_named
				CHECK ((kind = 'create-table') = (row_id IS NULL)),
			CONSTRAINT lookup_json_operations_target_named
				CHECK ((kind IN ('update-row', 'delete-row')) = (remote_id IS NOT NULL)),
			CONSTRAINT lookup_json_operations_settled
				CHECK ((state IN ('admitted', 'uncertain', 'review')) = (settled_at IS NULL)),
			FOREIGN KEY (project_id, server, domain, table_id)
				REFERENCES public.lookup_json_destinations (project_id, server, domain, table_id)
				ON DELETE CASCADE
		)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX lookup_json_operations_one_open
			ON public.lookup_json_operations (project_id, server, domain, table_id)
			WHERE state IN ('admitted', 'uncertain', 'review')
	`.execute(db);
	await sql`
		CREATE INDEX lookup_json_operations_destination
			ON public.lookup_json_operations (project_id, server, domain, table_id, admitted_at)
	`.execute(db);
	/* A lookup table's remote write may now be a JSON request. Added NOT
	 * VALID and validated after, so the check holds every row while the
	 * exclusive lock lasts only for the catalog change. */
	await sql`
		ALTER TABLE public.hq_remote_writes
			ADD CONSTRAINT hq_remote_writes_kind_pairs_json CHECK (
				(resource_kind = 'app' AND write_kind IN ('create', 'import', 'media'))
				OR (resource_kind = 'lookup-table' AND write_kind IN ('workbook', 'lookup-json'))
				OR (resource_kind = 'location' AND write_kind = 'places')
				OR (resource_kind = 'worker' AND write_kind = 'worker')) NOT VALID
	`.execute(db);
	await sql`ALTER TABLE public.hq_remote_writes VALIDATE CONSTRAINT hq_remote_writes_kind_pairs_json`.execute(
		db,
	);
	await sql`ALTER TABLE public.hq_remote_writes DROP CONSTRAINT hq_remote_writes_kind_pairs`.execute(
		db,
	);
}

/** Forward only: taking it back would forget which CommCare HQ rows are Nova's. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: taking it back would forget which CommCare HQ lookup rows Nova made, and the next publish could not tell them from anyone else's. A change to it goes forward in a new migration.",
	);
}
