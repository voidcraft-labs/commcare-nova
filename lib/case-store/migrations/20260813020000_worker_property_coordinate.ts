// Worker properties are first-class mintable entities on the executor path
// (handle-declared creation slots, wire-narrowed identity), so committed
// intent provenance names them by identity like their sibling collections
// (user types, personas) instead of coarsening every worker-property
// mutation to app scope.

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "app_change_intents_coordinate_kind_check";

const COORDINATE_KINDS =
	"'app', 'module', 'form', 'field', 'case-list-column', 'case-operation', " +
	"'worker-property', 'user-type', 'persona', 'organization-level', " +
	"'location-property', 'automation', 'case-property', 'external-action'";

const ORIGINAL_COORDINATE_KINDS =
	"'app', 'module', 'form', 'field', 'case-list-column', 'case-operation', " +
	"'user-type', 'persona', 'organization-level', 'location-property', " +
	"'automation', 'case-property', 'external-action'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_change_intents
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (coordinate_kind IN (${sql.raw(COORDINATE_KINDS)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_change_intents
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (coordinate_kind IN (${sql.raw(ORIGINAL_COORDINATE_KINDS)}))
	`.execute(db);
}
