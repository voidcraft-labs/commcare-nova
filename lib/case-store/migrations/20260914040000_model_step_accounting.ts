import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE public.design_model_steps ADD COLUMN response_append_key text`.execute(
		db,
	);
	await sql`ALTER TABLE public.design_model_steps ADD COLUMN admission jsonb`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE public.design_model_steps DROP COLUMN response_append_key`.execute(
		db,
	);
	await sql`ALTER TABLE public.design_model_steps DROP COLUMN admission`.execute(
		db,
	);
}
