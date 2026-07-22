// One database-wide serialization gate for Cloud Run traffic cutovers and
// compatibility-state mutations.
//
// The S02c2 controller holds the SESSION form of this lock on one dedicated
// database connection across a Cloud Run traffic mutation. Database DML
// triggers and the named compatibility operations take the transaction form,
// so traffic and durable rollout state cannot cross without serialization.
// Keep this module dependency-light: the case-store migration imports the
// stable numeric keys, while runtime services import the lock helper.

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "./pg";

/** Big-endian ASCII `NOVA`, kept in PostgreSQL's signed int32 range. */
export const DEPLOYMENT_CUTOVER_GATE_NAMESPACE = 0x4e4f5641;

/** Big-endian ASCII `CUTO`, kept in PostgreSQL's signed int32 range. */
export const DEPLOYMENT_CUTOVER_GATE_KEY = 0x4355544f;

/** Hold the deployment-cutover gate through the caller's current transaction. */
export async function lockDeploymentCutoverGate(
	tx: Transaction<AppDatabase>,
): Promise<void> {
	await sql`
		SELECT pg_catalog.pg_advisory_xact_lock(
			${DEPLOYMENT_CUTOVER_GATE_NAMESPACE}::integer,
			${DEPLOYMENT_CUTOVER_GATE_KEY}::integer
		)
	`.execute(tx);
}
