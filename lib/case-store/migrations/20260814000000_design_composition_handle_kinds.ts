/** Persist the identity-bearing worker-facing composition vocabulary. */

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "design_identity_handles_entity_kind_check";

const ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question', 'module_composition', " +
	"'form_composition', 'composition_section', 'composition_item', 'referenced'";

const PREVIOUS_ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question', 'referenced'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_identity_handles
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (entity_kind IN (${sql.raw(ENTITY_KINDS)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE design_identity_handles
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (entity_kind IN (${sql.raw(PREVIOUS_ENTITY_KINDS)}))
	`.execute(db);
}
