/**
 * Canonical authored-identity maintenance cutover.
 *
 * The implementation is isolated under the same timestamp so its parser,
 * occurrence inventory, transform, and database procedure remain one frozen
 * historical unit. Production runs this only after the maintenance drain and
 * exact forensic repair described in the Unit 18 runbook.
 */

import type { Kysely } from "kysely";
import { runFrozenCanonicalIdentityMigration } from "./20260728000000_canonical_identity_foundation/frozenDatabaseMigration";

export async function up(db: Kysely<unknown>): Promise<void> {
	await runFrozenCanonicalIdentityMigration(db);
}

export async function down(): Promise<void> {
	// Forward-only. Restoring the authoritative quiescent backup is the only
	// rollback after this transaction commits.
}
