// One database-wide serialization gate for Cloud Run traffic cutovers and
// compatibility-state mutations.
//
// The rollout controller holds the SESSION form of this lock on one dedicated
// database connection across a Cloud Run traffic mutation. Database DML
// triggers and the named compatibility operations take the transaction form,
// so traffic and durable rollout state cannot cross without serialization.
// Keep this module dependency-light: the case-store migration imports the
// stable numeric keys, while runtime services import the lock helper.

import { type Kysely, sql, type Transaction } from "kysely";
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

/** Another cutover session already owns the gate. */
export class DeploymentCutoverGateHeldError extends Error {
	readonly name = "DeploymentCutoverGateHeldError";
	constructor() {
		super(
			"Another deployment cutover holds the gate. Wait for it to finish, then re-run.",
		);
	}
}

/**
 * Hold the gate on ONE pinned connection across a multi-hour cutover, so the
 * phases between the floor raise and the flag enable cannot interleave with a
 * deploy or a second controller. Transactions opened on the session argument
 * re-take the gate in its transaction form; that is re-entrant within a session
 * by design.
 *
 * The lock is acquired with `try`, not a wait: a held gate means a cutover is
 * already in flight, and the honest answer is to abort rather than queue behind
 * it with a stale plan.
 *
 * `db` must be the pool-backed instance — a `Transaction` cannot pin a
 * connection, and Kysely's own typing rejects that misuse.
 */
export async function withDeploymentCutoverSession<T>(
	db: Kysely<AppDatabase>,
	run: (session: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	return db.connection().execute(async (session) => {
		const acquired = await sql<{ locked: boolean }>`
			SELECT pg_catalog.pg_try_advisory_lock(
				${DEPLOYMENT_CUTOVER_GATE_NAMESPACE}::integer,
				${DEPLOYMENT_CUTOVER_GATE_KEY}::integer
			) AS locked
		`.execute(session);
		if (acquired.rows[0]?.locked !== true) {
			throw new DeploymentCutoverGateHeldError();
		}
		try {
			return await run(session);
		} finally {
			await sql`
				SELECT pg_catalog.pg_advisory_unlock(
					${DEPLOYMENT_CUTOVER_GATE_NAMESPACE}::integer,
					${DEPLOYMENT_CUTOVER_GATE_KEY}::integer
				)
			`.execute(session);
		}
	});
}
