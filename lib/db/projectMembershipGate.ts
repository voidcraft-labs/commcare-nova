// One database-wide serialization gate for Better Auth Project membership.
//
// Membership DML takes the EXCLUSIVE transaction lock from the auth-app
// trigger. Any transaction whose authorization depends on membership takes the
// SHARED transaction lock before reading `auth_member`. A statement-level gate
// serializes missing rows too; a row lock alone cannot.
//
// Keep this module dependency-light. The auth migration imports the numeric
// keys, while app/case/stream writers import the shared-lock helper. Existing-
// app callers must lock `apps` before this gate; app creation is the explicit
// exception because no app row exists yet.

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "./pg";

/** Big-endian ASCII `NOVA`, kept in PostgreSQL's signed int32 range. */
export const PROJECT_MEMBERSHIP_GATE_NAMESPACE = 0x4e4f5641;

/** Big-endian ASCII `MEMB`, kept in PostgreSQL's signed int32 range. */
export const PROJECT_MEMBERSHIP_GATE_KEY = 0x4d454d42;

/** Hold the shared membership gate through the caller's current transaction. */
export async function lockProjectMembershipGateShared(
	tx: Transaction<AppDatabase>,
): Promise<void> {
	await sql`
		SELECT pg_catalog.pg_advisory_xact_lock_shared(
			${PROJECT_MEMBERSHIP_GATE_NAMESPACE}::integer,
			${PROJECT_MEMBERSHIP_GATE_KEY}::integer
		)
	`.execute(tx);
}
