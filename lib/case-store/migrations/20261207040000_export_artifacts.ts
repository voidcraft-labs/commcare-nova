import { type Kysely, sql } from "kysely";

const deploymentRelations = [
	"app_deployments",
	"app_deployment_resources",
	"app_deployment_identities",
	"app_deployment_baselines",
	"app_deployment_media_paths",
	"app_deployment_column_field_words",
	"app_deployment_keyed_case_ids",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE export_target_versions (project_id text NOT NULL,app_id text NOT NULL,revision bigint NOT NULL DEFAULT 1,
		PRIMARY KEY(project_id,app_id))`.execute(db);
	// The serving revision writes the tables this trigger fires on before
	// convergence grants it the ledger this migration creates, so the function
	// writes that ledger as its owner, through schema-qualified names only.
	await sql`CREATE FUNCTION nova_invalidate_export_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
	DECLARE tenant text; app text; held uuid;
	BEGIN
		IF TG_TABLE_NAME = 'app_deployments' THEN
			IF TG_OP = 'DELETE' THEN app:=OLD.app_id; tenant:=OLD.project_id;
			ELSE app:=NEW.app_id; tenant:=NEW.project_id; END IF;
		ELSE
			IF TG_OP = 'DELETE' THEN held:=OLD.deployment_id; ELSE held:=NEW.deployment_id; END IF;
			SELECT d.project_id,d.app_id INTO tenant,app FROM public.app_deployments d WHERE id=held;
		END IF;
		IF app IS NOT NULL THEN INSERT INTO public.export_target_versions(project_id,app_id) VALUES (tenant,app)
			ON CONFLICT(project_id,app_id) DO UPDATE SET revision=public.export_target_versions.revision+1; END IF;
		RETURN NULL;
	END $$`.execute(db);
	for (const table of deploymentRelations)
		await sql`CREATE TRIGGER nova_invalidate_export_target AFTER INSERT OR DELETE OR UPDATE ON ${sql.table(table)}
			FOR EACH ROW EXECUTE FUNCTION nova_invalidate_export_target()`.execute(
			db,
		);
	await sql`CREATE TABLE export_artifacts (
		id uuid PRIMARY KEY, project_id text NOT NULL, actor_id text NOT NULL, app_id text NOT NULL,
		grant_digest text NOT NULL, binding text NOT NULL, spec jsonb NOT NULL, lease_owner uuid, lease_until timestamptz,
		state text NOT NULL CHECK(state IN ('building','ready','deleting')),
		byte_length bigint NOT NULL DEFAULT 0 CHECK(byte_length >= 0),
		digest text CHECK(digest ~ '^[a-f0-9]{64}$'),
		expires_at timestamptz NOT NULL,
		UNIQUE(project_id,id), CHECK(state <> 'ready' OR digest IS NOT NULL)
	)`.execute(db);
	await sql`CREATE INDEX export_artifact_retry ON export_artifacts(project_id,actor_id,binding,expires_at DESC)`.execute(
		db,
	);
	await sql`CREATE INDEX export_artifact_cleanup ON export_artifacts (project_id,expires_at,id)`.execute(
		db,
	);
	await sql`CREATE TABLE export_artifact_parts (
		project_id text NOT NULL, artifact_id uuid NOT NULL, byte_offset bigint NOT NULL CHECK(byte_offset >= 0),
		byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 1048576),
		digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), generation text, write_intent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
		PRIMARY KEY(project_id,artifact_id,byte_offset),
		FOREIGN KEY(project_id,artifact_id) REFERENCES export_artifacts(project_id,id)
	)`.execute(db);
	for (const table of ["export_artifacts", "export_artifact_parts"])
		await sql`CREATE TRIGGER nova_account_lookup_storage AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(table)}
			FOR EACH ROW EXECUTE FUNCTION nova_account_lookup_storage()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM export_artifacts) THEN RAISE EXCEPTION 'Reclaim the retained exports before removing their journal.'; END IF; END $$`.execute(
		db,
	);
	for (const table of deploymentRelations)
		await sql`DROP TRIGGER nova_invalidate_export_target ON ${sql.table(table)}`.execute(
			db,
		);
	await sql`DROP FUNCTION nova_invalidate_export_target()`.execute(db);
	await sql`DROP TABLE export_artifact_parts, export_artifacts, export_target_versions`.execute(
		db,
	);
}
