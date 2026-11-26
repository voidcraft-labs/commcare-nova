import { type Kysely, sql } from "kysely";

/** Additive. An existing adoption has no recorded search settings until a
 * member confirms them. Bringing in another app never replaces that record. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE preview_search_settings (
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			server text NOT NULL,
			domain text NOT NULL,
			revision bigint NOT NULL CHECK (revision > 0),
			settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
			CHECK ((server = 'local' AND domain = '') OR
				(server IN ('production','india','eu') AND domain <> '')),
			PRIMARY KEY (project_id, server, domain)
		)
	`.execute(db);
	await sql`CREATE TABLE preview_search_setting_receipts (
		app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
		project_id text NOT NULL CHECK (btrim(project_id) <> ''),
		actor_id text NOT NULL,
		request_id text NOT NULL,
		input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
		saved_revision bigint NOT NULL CHECK (saved_revision > 0),
		PRIMARY KEY (app_id,project_id,actor_id,request_id)
	)`.execute(db);
}
