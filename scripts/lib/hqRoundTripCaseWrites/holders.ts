/**
 * Run holders during the case-writes cutover's window: step 4's file
 * (`scripts/lib/hqRoundTripPlatforms/holders.ts` at `a8af778e`), copied, its
 * session columns read from the admission scan's own list.
 *
 * With ingress closed nothing reaps a lapsed or paused holder, because
 * reaping is claim-driven, and the fleet transaction refuses any present
 * holder (the `holder` stop). `--settle-holders` therefore settles each one
 * the production reapers would: an app's stale build or stranded edit
 * through `lib/db/apps.ts::reapStaleRun`, and a design session's stale run
 * through `lib/db/designSessions.ts::reapStaleDesignSessionRun`, each
 * re-proving the exact holder (run id and holder nonce) and its staleness in
 * its own transaction. A live holder is left alone: the operator waits for
 * it, and the write refuses while it is there.
 */

import type { Transaction } from "kysely";
import { DESIGN_SESSION_LEASE_COLUMNS } from "@/lib/db/actorGenerationGate";
import { reapStaleRun } from "@/lib/db/apps";
import { reapStaleDesignSessionRun } from "@/lib/db/designSessions";
import { LEASE_COLUMNS, type LeaseRow, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import {
	type ExactRunHolderIdentity,
	toExactRunHolderIdentity,
} from "@/lib/db/runHolderWrites";
import {
	type DesignSessionLeaseRow,
	designSessionLeaseState,
	runLeaseState,
} from "@/lib/db/runLiveness";

/** Every holder the fleet holds, by what can be done about it. */
export interface HolderCensus {
	/** Apps and sessions whose holder is live: the write waits for it. */
	readonly liveApps: readonly string[];
	readonly liveSessions: readonly string[];
	/** Apps and sessions whose holder lapsed or is paused, which the reapers
	 *  settle once stale. */
	readonly settleableApps: readonly string[];
	readonly settleableSessions: readonly string[];
	/** An unsettled reservation with no holder present, which no reaper owns. */
	readonly unsettledApps: readonly string[];
	readonly unsettledSessions: readonly string[];
}

export function holderCensusIsEmpty(census: HolderCensus): boolean {
	return Object.values(census).every(
		(ids: readonly string[]) => ids.length === 0,
	);
}

type AppHolderRow = LeaseRow & { readonly id: string };
type SessionHolderRow = DesignSessionLeaseRow & { readonly id: string };

/** The census of rows already read: pure, so the scan, the writer's
 *  blocking scan and the tests decide it one way. */
export function holderCensusOf(
	apps: readonly AppHolderRow[],
	sessions: readonly SessionHolderRow[],
	now: number,
): HolderCensus {
	const liveApps: string[] = [];
	const settleableApps: string[] = [];
	const unsettledApps: string[] = [];
	for (const app of apps) {
		const lease = runLeaseState(leaseView(app), now);
		if (lease.live) liveApps.push(app.id);
		else if (lease.present) settleableApps.push(app.id);
		else if (lease.markerSettleable) unsettledApps.push(app.id);
	}
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

/** What the reapers would accept now: each holder's exact identity, where a
 *  reaper's staleness rule holds for it. Pure, over rows already read. */
export function reapableHolders(
	apps: readonly AppHolderRow[],
	sessions: readonly SessionHolderRow[],
	now: number,
): {
	readonly apps: readonly {
		readonly appId: string;
		readonly identity: ExactRunHolderIdentity;
	}[];
	readonly sessions: readonly {
		readonly designSessionId: string;
		readonly identity: ExactRunHolderIdentity;
	}[];
} {
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
}

async function readHolderRows(tx: Transaction<AppDatabase>): Promise<{
	apps: AppHolderRow[];
	sessions: SessionHolderRow[];
}> {
	const apps = await tx
		.selectFrom("apps")
		.select(["id", ...LEASE_COLUMNS])
		.orderBy("id")
		.execute();
	const sessions = await tx
		.selectFrom("design_sessions")
		.select([...DESIGN_SESSION_LEASE_COLUMNS])
		.orderBy("id")
		.execute();
	return { apps, sessions };
}

/** Read every app's and design session's holder on the caller's transaction. */
export async function readHolderCensus(
	tx: Transaction<AppDatabase>,
	now: number = Date.now(),
): Promise<HolderCensus> {
	const { apps, sessions } = await readHolderRows(tx);
	return holderCensusOf(apps, sessions, now);
}

export interface SettleOutcome {
	readonly appsSettled: number;
	readonly sessionsSettled: number;
	/** Reaps that threw, which the reaper logged; the scan still counts
	 *  their holders. */
	readonly failed: number;
}

/**
 * Settle every lapsed or paused holder whose staleness a reaper accepts. A
 * paused build becomes reapable once its staleness window has passed; one
 * that has not stays, and the scan still counts it. Each reaper re-proves the
 * exact holder in its own transaction, so a holder that came back to life
 * since the read is left alone, and what is counted is what each reaper
 * reports it reaped, so this agrees with the census.
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
			const { apps, sessions } = await readHolderRows(tx);
			return reapableHolders(apps, sessions, now);
		});
	let appsSettled = 0;
	for (const { appId, identity } of reapable.apps) {
		if ((await reapStaleRun(appId, identity)) === "reaped") appsSettled += 1;
	}
	let sessionsSettled = 0;
	let failed = 0;
	for (const { designSessionId, identity } of reapable.sessions) {
		const outcome = await reapStaleDesignSessionRun(designSessionId, identity);
		if (outcome === "reaped") sessionsSettled += 1;
		else if (outcome === "failed") failed += 1;
	}
	return { appsSettled, sessionsSettled, failed };
}
