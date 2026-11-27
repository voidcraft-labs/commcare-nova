import { type Kysely, sql } from "kysely";

/**
 * A non-secret version of a person's CommCare HQ connection. Bindings that
 * must break when the connection is saved again (a lookup table's scope, a
 * worker group's state, a private export's grant) name this instead of the
 * stored key, so no key material, encrypted or not, reaches a digest. Each
 * existing row gets a fresh value, which reads as a connection saved again:
 * the safe path every such binding already takes.
 *
 * Additive with a default: the revision still serving writes rows without the
 * column, and each gets its own value.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE user_settings ADD COLUMN connection_epoch uuid NOT NULL DEFAULT gen_random_uuid()`.execute(
		db,
	);
}

export async function down(): Promise<void> {
	throw new Error(
		"Dropping the connection version would leave every binding over it unreadable.",
	);
}
