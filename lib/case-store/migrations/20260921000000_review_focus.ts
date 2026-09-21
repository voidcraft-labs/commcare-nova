import { type Kysely, sql } from "kysely";

/** Persist the correction request before a peer can be interrupted. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE authoring_reviews ADD COLUMN focus text`.execute(db);
}
