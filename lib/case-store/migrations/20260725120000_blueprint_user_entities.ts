// `blueprint_entities` gains the three flat user collections — the
// user-data property catalog, the user types built on it, and the named
// preview personas. They are ordinary blueprint entities with no parent
// and no membership array, so the only schema change is widening the kind
// constraint; the row shape is unchanged.

import { type Kysely, sql } from "kysely";

const KINDS =
	"'module', 'form', 'field', 'user_property', 'user_type', 'persona'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.blueprint_entities
			DROP CONSTRAINT IF EXISTS blueprint_entities_kind_check
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			ADD CONSTRAINT blueprint_entities_kind_check
				CHECK (kind IN (${sql.raw(KINDS)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		DELETE FROM public.blueprint_entities
			WHERE kind IN ('user_property', 'user_type', 'persona')
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			DROP CONSTRAINT IF EXISTS blueprint_entities_kind_check
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			ADD CONSTRAINT blueprint_entities_kind_check
				CHECK (kind IN ('module', 'form', 'field'))
	`.execute(db);
}
