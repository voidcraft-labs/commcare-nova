import { type Kysely, sql } from "kysely";

const relations = [
	"worker_groups",
	"worker_group_members",
	"worker_group_targets",
	"lookup_row_assignments",
] as const;

export async function up(db: Kysely<unknown>) {
	await sql`ALTER TABLE lookup_tables ADD COLUMN worker_access text NOT NULL DEFAULT 'all' CHECK(worker_access IN ('all','assigned'))`.execute(
		db,
	);
	// Existing lookup_tables tuples were accounted under the previous shape.
	await sql`UPDATE lookup_storage_budgets b SET used_bytes=used_bytes+d.bytes FROM (
		SELECT project_id,sum(octet_length(to_jsonb(t)::text)-octet_length((to_jsonb(t)-'worker_access')::text)) bytes
		FROM lookup_tables t GROUP BY project_id) d WHERE d.project_id=b.project_id`.execute(
		db,
	);
	await sql`CREATE TABLE worker_groups (
		project_id text NOT NULL, id uuid NOT NULL DEFAULT uuidv7(),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 255),
		shares_cases boolean NOT NULL DEFAULT false,metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
		PRIMARY KEY(project_id,id)
	)`.execute(db);
	await sql`CREATE TABLE worker_group_members(
		project_id text NOT NULL,group_id uuid NOT NULL,app_id text NOT NULL,persona_id uuid NOT NULL,
		PRIMARY KEY(project_id,app_id,persona_id,group_id),
		FOREIGN KEY(project_id,group_id) REFERENCES worker_groups ON DELETE CASCADE,
		FOREIGN KEY(app_id) REFERENCES apps(id) ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE TABLE worker_group_targets(
		project_id text NOT NULL,group_id uuid NOT NULL,server text NOT NULL,domain text NOT NULL,
		remote_id text NOT NULL CHECK(length(remote_id)>0), confirmed_name text NOT NULL,
		PRIMARY KEY(project_id,group_id,server,domain), UNIQUE(project_id,server,domain,remote_id),
		FOREIGN KEY(project_id,group_id) REFERENCES worker_groups ON DELETE CASCADE
	)`.execute(db);
	await sql`CREATE TABLE lookup_row_assignments(
		project_id text NOT NULL,table_id uuid NOT NULL,row_id uuid NOT NULL,
		kind text NOT NULL CHECK(kind IN ('worker','place','group')),app_id text,
		principal_id uuid NOT NULL, group_id uuid GENERATED ALWAYS AS(CASE WHEN kind='group' THEN principal_id END) STORED,
		CHECK ((kind='group')=(app_id IS NULL)),
		UNIQUE NULLS NOT DISTINCT(project_id,table_id,row_id,kind,app_id,principal_id),
		FOREIGN KEY(project_id,table_id,row_id) REFERENCES lookup_rows ON DELETE CASCADE,
		FOREIGN KEY(app_id) REFERENCES apps(id) ON DELETE CASCADE,
		FOREIGN KEY(project_id,group_id) REFERENCES worker_groups ON DELETE RESTRICT
	)`.execute(db);
	await sql`CREATE INDEX lookup_assignments_principal ON lookup_row_assignments(project_id,table_id,kind,app_id,principal_id,row_id)`.execute(
		db,
	);
	// The tenant check a composite (project_id, app_id) key would make. The
	// auth-app tenancy migration keeps an exact catalog of every constraint
	// on apps.project_id (lib/auth/migrations/20260728010000_apps_project_tenancy.ts),
	// so the row's Project is proved here instead. FOR KEY SHARE holds the
	// app's (project_id, id) key, so a Project move waits for this write and
	// then refuses the app while an assignment names it
	// (lib/db/apps.ts::assertMoveLookupClosureEmpty).
	await sql`CREATE FUNCTION nova_check_assignment_app_project() RETURNS trigger
		LANGUAGE plpgsql SET search_path=pg_catalog AS $$
	BEGIN
		IF NEW.app_id IS NOT NULL THEN
			PERFORM 1 FROM public.apps WHERE id=NEW.app_id AND project_id=NEW.project_id FOR KEY SHARE;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'An assignment names an app outside its Project.' USING ERRCODE='23503';
			END IF;
		END IF;
		RETURN NEW;
	END $$`.execute(db);
	for (const relation of ["worker_group_members", "lookup_row_assignments"])
		await sql`CREATE TRIGGER nova_check_assignment_app_project BEFORE INSERT OR UPDATE OF project_id,app_id ON ${sql.table(relation)} FOR EACH ROW EXECUTE FUNCTION nova_check_assignment_app_project()`.execute(
			db,
		);
	for (const relation of relations)
		await sql`CREATE TRIGGER nova_account_lookup_storage AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(relation)} FOR EACH ROW EXECUTE FUNCTION nova_account_lookup_storage()`.execute(
			db,
		);
}

export async function down(db: Kysely<unknown>) {
	await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM worker_groups) OR EXISTS (SELECT 1 FROM lookup_tables WHERE worker_access='assigned')
	OR EXISTS (SELECT 1 FROM lookup_row_assignments) THEN RAISE EXCEPTION 'Restore the verified worker assignment backup.'; END IF; END $$`.execute(
		db,
	);
	for (const relation of [...relations].reverse())
		await sql`DROP TABLE ${sql.table(relation)}`.execute(db);
	await sql`DROP FUNCTION nova_check_assignment_app_project()`.execute(db);
	await sql`UPDATE lookup_storage_budgets b SET used_bytes=used_bytes-d.bytes FROM (
		SELECT project_id,sum(octet_length(to_jsonb(t)::text)-octet_length((to_jsonb(t)-'worker_access')::text)) bytes
		FROM lookup_tables t GROUP BY project_id) d WHERE d.project_id=b.project_id`.execute(
		db,
	);
	await sql`ALTER TABLE lookup_tables DROP COLUMN worker_access`.execute(db);
}
