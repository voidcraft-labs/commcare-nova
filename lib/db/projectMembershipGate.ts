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

/**
 * Hold the EXCLUSIVE membership gate through the caller's current
 * transaction — the same lock the auth-app trigger takes on `auth_member`
 * DML. A transaction that reads membership/invitation state and then
 * writes it (the MCP Project-management writers in `lib/projects/manage.ts`)
 * takes this FIRST, before any read: taking the shared lock and upgrading
 * on write would deadlock against a concurrent holder doing the same, and
 * relying on the trigger alone would let two read-then-write transactions
 * both pass their reads before either writes.
 *
 * Know the gate's blind spot: the trigger fires on `auth_member` DML only.
 * Better Auth's session-path invitation INSERT touches `auth_invitation`
 * alone, so it takes no lock here — a gated read of invitation state is
 * exact against MCP writers and against membership changes, but best-effort
 * against a concurrent session-path invite (worst case: a duplicate pending
 * invitation, which acceptance resolves harmlessly).
 *
 * Generic over the transaction's database type because the callers run on
 * the auth store's Kysely handle (`Transaction<AuthDatabase>`) while this
 * module stays dependency-light; the advisory lock is database-wide and
 * touches no tables, so the type parameter carries no meaning here.
 */
export async function lockProjectMembershipGateExclusive<DB>(
	tx: Transaction<DB>,
): Promise<void> {
	await sql`
		SELECT pg_catalog.pg_advisory_xact_lock(
			${PROJECT_MEMBERSHIP_GATE_NAMESPACE}::integer,
			${PROJECT_MEMBERSHIP_GATE_KEY}::integer
		)
	`.execute(tx);
}
