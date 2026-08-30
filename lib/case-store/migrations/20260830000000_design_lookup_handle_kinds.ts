// Admit the identity-bearing Project-data intent vocabulary to the durable
// design handle ledger. Earlier application code could construct these
// bindings, but the database correctly refused their unknown entity kinds.
// This forward schema migration makes the database and current runtime
// contract agree before any design process can stage a lookup intent.

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "design_identity_handles_entity_kind_check";

const ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question', 'module_composition', " +
	"'form_composition', 'composition_section', 'composition_item', " +
	"'lookup_table_intent', 'lookup_column_intent', 'lookup_row_intent', " +
	"'referenced'";

const PREVIOUS_ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question', 'module_composition', " +
	"'form_composition', 'composition_section', 'composition_item', 'referenced'";

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
