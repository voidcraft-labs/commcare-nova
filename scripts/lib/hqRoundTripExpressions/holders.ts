/**
 * Run holders during the expressions cutover's window: step 2's file
 * (`scripts/lib/hqRoundTripCutover/holders.ts` at `f9218b7e`), copied.
 *
 * With ingress closed nothing reaps a lapsed or paused holder, because
 * reaping is claim-driven, and the fleet transaction refuses any present
 * holder. `--settle-holders` therefore settles each one the production
 * reapers would: an app's stale build or stranded edit through
 * `lib/db/apps.ts::reapStaleRun`, and a design session's stale run through
 * `lib/db/designSessions.ts::reapStaleDesignSessionRun`, each re-proving the
 * exact holder and its staleness in its own transaction. A live holder is
 * left alone: the operator waits for it, and the write refuses while it is
 * there.
 */

import type { Transaction } from "kysely";
import { reapStaleRun } from "@/lib/db/apps";
import { reapStaleDesignSessionRun } from "@/lib/db/designSessions";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { toExactRunHolderIdentity } from "@/lib/db/runHolderWrites";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";

const SESSION_LEASE_COLUMNS = [
	"id",
	"state",
	"awaiting_input",
	"owner_user_id",
	"run_id",
	"run_holder_nonce",
	"run_actor_user_id",
	"run_mode",
	"run_lease_expires_at",
	"res_period",
	"res_reserved",
	"res_settled",
	"res_user_id",
	"res_run_id",
	"updated_at",
] as const;

/** Every holder the fleet holds, by what can be done about it. */
export interface HolderCensus {
	/** Apps whose holder is live: the write waits for it. */
	readonly liveApps: readonly string[];
	readonly liveSessions: readonly string[];
	/** Apps and sessions whose holder lapsed or is paused, which the reapers settle once stale. */
	readonly settleableApps: readonly string[];
	readonly settleableSessions: readonly string[];
	/** An unsettled reservation with no holder present, which no reaper owns. */
	readonly unsettledApps: readonly string[];
	readonly unsettledSessions: readonly string[];
}

export function holderCensusIsEmpty(census: HolderCensus): boolean {
	return Object.values(census).every((ids) => ids.length === 0);
}

/** Read every app's and design session's holder on the caller's transaction. */
export async function readHolderCensus(
	tx: Transaction<AppDatabase>,
	now: number = Date.now(),
): Promise<HolderCensus> {
	const apps = await tx
		.selectFrom("apps")
		.select(["id", ...LEASE_COLUMNS])
		.orderBy("id")
		.execute();
	const liveApps: string[] = [];
	const settleableApps: string[] = [];
	const unsettledApps: string[] = [];
	for (const app of apps) {
		const lease = runLeaseState(leaseView(app), now);
		if (lease.live) liveApps.push(app.id);
		else if (lease.present) settleableApps.push(app.id);
		else if (lease.markerSettleable) unsettledApps.push(app.id);
	}
	const sessions = await tx
		.selectFrom("design_sessions")
		.select([...SESSION_LEASE_COLUMNS])
		.orderBy("id")
		.execute();
	const liveSessions: string[] = [];
	const settleableSessions: string[] = [];
	const unsettledSessions: string[] = [];
	for (const session of sessions) {
		const lease = designSessionLeaseState(session, now);
		if (lease.live) liveSessions.push(session.id);
		else if (lease.present) settleableSessions.push(session.id);
		else if (lease.markerSettleable) unsettledSessions.push(session.id);
	}
	return {
		liveApps,
		liveSessions,
		settleableApps,
		settleableSessions,
		unsettledApps,
		unsettledSessions,
	};
}

export interface SettleOutcome {
	readonly appsSettled: number;
	readonly sessionsSettled: number;
}

/**
 * Settle every lapsed or paused holder whose staleness a reaper accepts. A
 * paused build becomes reapable once its staleness window has passed; one
 * that has not stays, and the scan still counts it. Each reaper re-proves the
 * exact holder in its own transaction, so a holder that came back to life
 * since the read is left alone.
 */
export async function settleHolders(
	now: number = Date.now(),
): Promise<SettleOutcome> {
	const db = await getAppDb();
	const reapable = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const apps = await tx
				.selectFrom("apps")
				.select(["id", ...LEASE_COLUMNS])
				.orderBy("id")
				.execute();
			const sessions = await tx
				.selectFrom("design_sessions")
				.select([...SESSION_LEASE_COLUMNS])
				.orderBy("id")
				.execute();
			return {
				apps: apps.flatMap((app) => {
					const lease = runLeaseState(leaseView(app), now);
					const identity = toExactRunHolderIdentity(lease.holderIdentity);
					return identity !== null &&
						!lease.live &&
						(lease.reapableStaleBuild || lease.reapableStrandedEdit)
						? [{ appId: app.id, identity }]
						: [];
				}),
				sessions: sessions.flatMap((session) => {
					const lease = designSessionLeaseState(session, now);
					const identity = toExactRunHolderIdentity(lease.holderIdentity);
					return identity !== null && lease.reapableStaleRun
						? [{ designSessionId: session.id, identity }]
						: [];
				}),
			};
		});
	let appsSettled = 0;
	for (const { appId, identity } of reapable.apps) {
		if ((await reapStaleRun(appId, identity)) === "reaped") appsSettled += 1;
	}
	for (const { designSessionId, identity } of reapable.sessions) {
		await reapStaleDesignSessionRun(designSessionId, identity);
	}
	return { appsSettled, sessionsSettled: reapable.sessions.length };
}
