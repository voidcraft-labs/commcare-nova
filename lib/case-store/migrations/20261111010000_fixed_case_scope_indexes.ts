import { type Kysely, sql } from "kysely";

/** A fixed fleet-wide index set. Schema/property growth never creates indexes.
 * Deployment requires the separately reviewed historical-index retirement. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE INDEX cases_project_app_type_idx ON cases (project_id, app_id, case_type)`.execute(
		db,
	);
	await sql`CREATE INDEX cases_app_type_idx ON cases (app_id, case_type)`.execute(
		db,
	);
}
export async function down(): Promise<void> {
	throw new Error("Fixed case scope indexes are forward-only.");
}
