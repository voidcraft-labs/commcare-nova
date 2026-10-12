import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE threads ADD COLUMN selected_sources jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE threads DROP COLUMN selected_sources`.execute(db);
}
