import { type Kysely, sql } from "kysely";

/** The HQ profile key and the ID of the worker whose restore it builds belong to one deployment.
 * Existing deployments gain rows only from an observed target. */
export async function up<Database>(db: Kysely<Database>): Promise<void> {
	await sql`ALTER TABLE public.hq_remote_writes
  ADD COLUMN IF NOT EXISTS import_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS import_acknowledged_version bigint
 `.execute(db);
 await sql`ALTER TABLE public.hq_remote_writes DROP CONSTRAINT IF EXISTS installation_import_acknowledgement`.execute(db);
 await sql`ALTER TABLE public.hq_remote_writes ADD CONSTRAINT installation_import_acknowledgement CHECK (
   (import_acknowledged_at IS NULL AND import_acknowledged_version IS NULL) OR
   (import_acknowledged_at IS NOT NULL AND write_kind='import' AND resource_id IS NOT NULL AND
    (import_acknowledged_version IS NULL OR import_acknowledged_version >= 0))
  )`.execute(db);
 await sql`ALTER TABLE public.app_deployment_baselines ADD COLUMN IF NOT EXISTS installation_review jsonb`.execute(
		db,
	);
	await sql`CREATE TABLE IF NOT EXISTS public.app_deployment_installation_profiles (
		deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
		nova_profile_uuid uuid NOT NULL,
		profile_key text NOT NULL CHECK (profile_key <> ''),
		practice_worker_id text CHECK (practice_worker_id <> ''),
		practice_witness jsonb CHECK (practice_witness IS NULL OR practice_worker_id IS NOT NULL),
		PRIMARY KEY (deployment_id, nova_profile_uuid),
		-- The equality exclusion rechecks the complete pair on a hash match.
		-- Its hash index stores four bytes even for a long, incompressible HQ key.
		CONSTRAINT installation_profile_destination_key EXCLUDE USING hash
			((ARRAY[deployment_id::text, profile_key]) COLLATE "C" WITH =)
	)`.execute(db);
	await sql`CREATE TABLE IF NOT EXISTS public.app_deployment_installation_reviews (
		deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
		actor_id text NOT NULL,
		checkpoint jsonb NOT NULL,
		PRIMARY KEY (deployment_id, actor_id)
	)`.execute(db);
}

export async function down<Database>(db: Kysely<Database>): Promise<void> {
	await sql`ALTER TABLE public.hq_remote_writes DROP COLUMN IF EXISTS import_acknowledged_at, DROP COLUMN IF EXISTS import_acknowledged_version`.execute(db);
 await sql`ALTER TABLE public.app_deployment_baselines DROP COLUMN IF EXISTS installation_review`.execute(
		db,
	);
	await sql`DROP TABLE IF EXISTS public.app_deployment_installation_reviews`.execute(
		db,
	);
	await sql`DROP TABLE IF EXISTS public.app_deployment_installation_profiles`.execute(
		db,
	);
}
