// Places join the ownership ledger.
//
// A lookup table and a place are the same kind of fact about a project
// space: Nova put it there, or somebody named an existing one and said to
// take it over. So a place is a `kind` on the mapping that already exists
// rather than a table of its own, and everything the ledger already does
// for a table applies unchanged — the partial unique index that keeps one
// live mapping per resource, the supersession that reports what an earlier
// publish left behind, the attribution an adoption carries.
//
// `pushed_identity` holds the place's site code. That code is create-once
// in Nova and domain-unique on CommCare HQ, so unlike a table's tag it
// never changes underneath a mapping; what it answers is the other
// question, "what is still sitting over there", for a place the app
// archived and Nova therefore stopped pushing.
//
// Every statement is idempotent, so a database that has already seen an
// earlier shape of this constraint converges rather than fails.

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "app_deployment_resources_kind_check";

const RESOURCE_KINDS = "'app', 'lookup-table', 'location'";
const PREVIOUS_RESOURCE_KINDS = "'app', 'lookup-table'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (kind IN (${sql.raw(RESOURCE_KINDS)}))
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Rows of the departing kind go first: the constraint cannot come back
	// while a row contradicts it, and a down migration that fails halfway
	// is worse than one that gives up the mappings it is undoing.
	await sql`
		DELETE FROM app_deployment_resources WHERE kind = 'location'
	`.execute(db);

	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (kind IN (${sql.raw(PREVIOUS_RESOURCE_KINDS)}))
	`.execute(db);
}
