/**
 * Canonical authored-identity cutover.
 *
 * The implementation is isolated under the same timestamp so its parser,
 * occurrence inventory, transform, and database procedure remain one frozen
 * historical unit.
 *
 * The forensic repair runs here, first, inside Kysely's migration transaction —
 * not as an operator step before it. One deploy therefore does the whole
 * cutover: the deploy identity already holds the write authority the repair
 * needs, and there is no interval in which the repair has landed and the
 * migration has not. Both hold the same complete table lock, so a concurrent
 * writer blocks on it or fails against it; a request already in flight against
 * the old shape may error, and that is the accepted cost.
 */

import type { Kysely } from "kysely";
import { runFrozenCanonicalIdentityMigration } from "./20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import { runFrozenCanonicalIdentityRepairInTransaction } from "./20260728000000_canonical_identity_foundation/frozenDatabaseRepair";

export async function up(db: Kysely<unknown>): Promise<void> {
	await runFrozenCanonicalIdentityRepairInTransaction(db, { apply: true });
	await runFrozenCanonicalIdentityMigration(db);
}

export async function down(): Promise<void> {
	throw new Error(
		"Canonical identity foundation is forward-only; restore the authoritative quiescent backup instead.",
	);
}
