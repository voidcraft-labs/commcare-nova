import { type Kysely, sql } from "kysely";

/** Deployment evidence only. Existing deployments require a new publish. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments
  ADD COLUMN IF NOT EXISTS content_generation uuid,
  ADD COLUMN IF NOT EXISTS entry_point_manifest jsonb,
  ADD COLUMN IF NOT EXISTS entry_point_observation jsonb`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments
  DROP COLUMN IF EXISTS entry_point_observation,
  DROP COLUMN IF EXISTS entry_point_manifest,
  DROP COLUMN IF EXISTS content_generation`.execute(db);
}
