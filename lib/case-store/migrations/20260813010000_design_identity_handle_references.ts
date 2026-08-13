// Order-free design staging: forward references join the identity ledger.
//
// Design identities are minted deterministically from (session, handle), so a
// reference and its later declaration always converge on one UUID. Staging
// previously refused a reference whose declaration had not landed yet, which
// forced a topological authoring order (a charter could not be staged before
// a new workflow it includes) that models reliably fail to infer. References
// now bind eagerly under the marker kind 'referenced'; the declaring item
// upgrades that row to its real kind, and submit-time reference closure still
// refuses any referenced element that was never authored — naming the handle,
// which this row is what makes possible.

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "design_identity_handles_entity_kind_check";

const ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question', 'referenced'";

const ORIGINAL_ENTITY_KINDS =
	"'contract', 'actor', 'record', 'property', 'workflow', 'list', " +
	"'access', 'navigation', 'external_requirement', 'decision', " +
	"'assumption', 'open_question'";

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
				CHECK (entity_kind IN (${sql.raw(ORIGINAL_ENTITY_KINDS)}))
	`.execute(db);
}
