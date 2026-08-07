import "server-only";

import {
	Kysely,
	PostgresDialect,
	type PostgresPool,
	type PostgresPoolClient,
} from "kysely";
import { POOL_MAX_PER_INSTANCE } from "@/lib/case-store/postgres/connection";
import { type AppDatabase, getAppPool } from "@/lib/db/pg";

/**
 * Serialize a critical section that spans more than one transaction.
 *
 * Transaction advisory locks (`pg_advisory_xact_lock`) release at COMMIT, so
 * they cannot protect a body that commits partway through or that waits on
 * another system in between. That is the shape of media publication, the
 * caller here: it holds its content identity across GCS bytes plus committed
 * metadata, and cannot pretend Postgres and GCS share a transaction.
 *
 * So this checks out ONE session, takes session-scoped advisory locks on it,
 * and holds them until the body ends. The body also receives a Kysely handle
 * pinned to that same session, so a caller that needs its SQL on the locked
 * connection has it without a second checkout; callers that only need mutual
 * exclusion can ignore it and use the ordinary pool, because the lock excludes
 * other LOCK HOLDERS regardless of which connection their statements run on.
 *
 * The held session is the cost, and it prices the whole pattern: a body
 * pins one pooled connection for its full duration, so this fits work
 * measured in the time a GCS write takes and does NOT fit work that waits
 * on a slow third party. The deployment lifecycle deliberately does not
 * use it for exactly that reason: a publish spends minutes talking to
 * CommCare HQ, and holds no lock at all; its writes fold against the
 * fresh row per transaction instead (`lib/deployment/store.ts`).
 *
 * Identities are sorted before acquisition so every caller takes them in the
 * same order and an A-then-B body cannot deadlock against a B-then-A one. A
 * hash collision only over-serializes two unrelated identities; it can never
 * weaken safety.
 */

// Keep one pooled connection available for unrelated request work. Every lock
// body may reuse its checked-out session for SQL, so two concurrent holders
// consume two of the current pool slots rather than two locks plus two
// additional connections. This counter is process-wide ON PURPOSE so that a
// second feature adopting this lock shares the budget: separate per-feature
// counters would each believe they had the whole budget and together
// oversubscribe it.
const MAX_LOCAL_SESSION_LOCKS = Math.max(1, POOL_MAX_PER_INSTANCE - 1);
let localSessionLocks = 0;
const localSessionLockWaiters: Array<() => void> = [];

async function acquirePermit(): Promise<void> {
	if (localSessionLocks < MAX_LOCAL_SESSION_LOCKS) {
		localSessionLocks++;
		return;
	}
	await new Promise<void>((resolve) => {
		localSessionLockWaiters.push(() => {
			localSessionLocks++;
			resolve();
		});
	});
}

function releasePermit(): void {
	localSessionLocks--;
	localSessionLockWaiters.shift()?.();
}

function databasePinnedToClient(
	client: import("pg").PoolClient,
	poolOptions: object,
): Kysely<AppDatabase> {
	const pinnedClient: PostgresPoolClient = {
		query: client.query.bind(client) as PostgresPoolClient["query"],
		// Kysely releases after each ordinary query/transaction. The outer
		// session lock owns the real checkout and releases it only after the
		// advisory unlock.
		release: () => {},
	};
	const pinnedPool: PostgresPool = {
		connect: async () => pinnedClient,
		end: async () => {},
		options: poolOptions,
	};
	return new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool: pinnedPool }),
	});
}

/**
 * Hold every named identity for the duration of `body`.
 *
 * `label` names the caller in the error raised if an unlock reports no held
 * lock, which means the session was reset underneath us and must not go back
 * to the pool.
 */
export async function withSessionAdvisoryLocks<T>(
	identities: readonly string[],
	label: string,
	body: (lockedDb: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	const lockIdentities = [...new Set(identities)].sort();
	if (lockIdentities.length === 0) {
		throw new Error(`${label} requires at least one lock identity.`);
	}
	await acquirePermit();
	try {
		const pool = await getAppPool();
		const client = await pool.connect();
		const acquired: string[] = [];
		let lockedDb: Kysely<AppDatabase> | null = null;
		let discardClient: Error | undefined;
		let failed = false;
		let failure: unknown;
		let value!: T;
		try {
			try {
				for (const identity of lockIdentities) {
					await client.query(
						"SELECT pg_advisory_lock(hashtextextended($1, 0::bigint))",
						[identity],
					);
					acquired.push(identity);
				}
				lockedDb = databasePinnedToClient(client, pool.options);
				value = await body(lockedDb);
			} catch (error) {
				failed = true;
				failure = error;
			}
			try {
				await lockedDb?.destroy();
			} catch (error) {
				if (!failed) {
					failed = true;
					failure = error;
				}
			}
			for (let index = acquired.length - 1; index >= 0; index--) {
				const identity = acquired[index];
				try {
					const result = await client.query<{ unlocked: boolean }>(
						"SELECT pg_advisory_unlock(hashtextextended($1, 0::bigint)) AS unlocked",
						[identity],
					);
					if (result.rows[0]?.unlocked !== true) {
						throw new Error(
							`${label} advisory unlock reported no held lock for ${identity}.`,
						);
					}
				} catch (error) {
					discardClient =
						error instanceof Error
							? error
							: new Error(`${label} advisory unlock failed.`);
					if (!failed) {
						failed = true;
						failure = error;
					}
				}
			}
		} finally {
			client.release(discardClient);
		}
		if (failed) throw failure;
		return value;
	} finally {
		releasePermit();
	}
}
