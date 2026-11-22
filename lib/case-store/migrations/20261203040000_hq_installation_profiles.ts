import { type Kysely, sql } from "kysely";

/** The HQ profile key and the ID of the worker whose restore it builds belong to one deployment.
 * Existing deployments gain rows only from an observed target. */
export async function up<Database>(db: Kysely<Database>): Promise<void> {
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
		UNIQUE (deployment_id, profile_key)
	)`.execute(db);
	await sql`CREATE TABLE IF NOT EXISTS public.app_deployment_installation_reviews (
		deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
		actor_id text NOT NULL,
		checkpoint jsonb NOT NULL,
		PRIMARY KEY (deployment_id, actor_id)
	)`.execute(db);
}

export async function down<Database>(db: Kysely<Database>): Promise<void> {
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
