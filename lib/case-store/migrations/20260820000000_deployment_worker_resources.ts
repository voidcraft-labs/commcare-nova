// Mobile workers join the ownership ledger.
//
// A worker is the third `kind` on the same mapping, and for the same
// reason the first two were: Nova either made the account or somebody
// named an existing one and said to take it over, and the ledger already
// knows how to hold that — one live mapping per Nova resource, an
// attribution on every adoption, supersession that reports what an
// earlier act left on the project space.
//
// `nova_resource_id` is the PERSONA's uuid and `pushed_identity` is the
// full username the account carries there. The two are separate on
// purpose: a persona is a design actor that can be provisioned on several
// project spaces under a different name on each, so the username belongs
// to this mapping rather than to the blueprint. `remote_id` is CommCare
// HQ's `user_id`, which is the durable key the usercase and session keys
// ride on.
//
// What the ledger deliberately does NOT hold is a credential. A worker's
// password is generated per account, handed back once, and stored
// nowhere — there is no column here for it and there is not meant to be.
//
// Every statement is idempotent, so a database that has already seen an
// earlier shape of this constraint converges rather than fails.

import { type Kysely, sql } from "kysely";

const KIND_CHECK = "app_deployment_resources_kind_check";

const RESOURCE_KINDS = "'app', 'lookup-table', 'location', 'worker'";
const PREVIOUS_RESOURCE_KINDS = "'app', 'lookup-table', 'location'";

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
	//
	// Dropping the row does not touch the account. CommCare HQ still holds
	// every worker Nova made; what is lost is Nova's record of which
	// persona each one stands for.
	await sql`
		DELETE FROM app_deployment_resources WHERE kind = 'worker'
	`.execute(db);

	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (kind IN (${sql.raw(PREVIOUS_RESOURCE_KINDS)}))
	`.execute(db);
}
