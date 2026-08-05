// Persist human-applied automations as ordinary normalized Blueprint entities.

import { type Kysely, sql } from "kysely";

const KINDS =
	"'module', 'form', 'field', 'user_property', 'user_type', 'persona', " +
	"'organization_level', 'location_property', 'automation'";

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
		DELETE FROM public.blueprint_entities WHERE kind = 'automation'
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			DROP CONSTRAINT IF EXISTS blueprint_entities_kind_check
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			ADD CONSTRAINT blueprint_entities_kind_check
				CHECK (kind IN (
					'module', 'form', 'field', 'user_property', 'user_type',
					'persona', 'organization_level', 'location_property'
				))
	`.execute(db);
}
