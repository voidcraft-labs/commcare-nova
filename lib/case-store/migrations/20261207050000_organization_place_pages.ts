import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// HQ metadata can contain escaped NULs or lone surrogates in unmodeled keys and values.
	// Postgres text preserves the serialized observation while jsonb rejects those strings.
	await sql`ALTER TABLE app_locations ADD COLUMN hq_observation text`.execute(db);
	await sql`CREATE INDEX app_locations_children_page ON app_locations(app_id, parent_id, order_key, id)`.execute(db);
	await sql`CREATE INDEX app_locations_exact_name ON app_locations(app_id, name)`.execute(db);
	// A source code is case-sensitive. Only destination matching folds it.
	await sql`CREATE INDEX app_locations_destination_code ON app_locations(app_id, lower(site_code))`.execute(db);
	await sql`ALTER TABLE app_deployment_confirmations DROP CONSTRAINT app_deployment_confirmations_worker_level_subject,
		ADD CONSTRAINT app_deployment_confirmations_worker_level_subject CHECK (kind <> 'worker-level' OR length(subject) BETWEEN 0 AND 50)`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error("Restoring the earlier schema would discard source place observations.");
}
