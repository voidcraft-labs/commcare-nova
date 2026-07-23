import "server-only";

import {
	Kysely,
	PostgresDialect,
	type PostgresPool,
	type PostgresPoolClient,
} from "kysely";
import {
	getCaseStorePool,
	POOL_MAX_PER_INSTANCE,
} from "@/lib/case-store/postgres/connection";
import type { AppDatabase } from "@/lib/db/pg";

// Keep one pooled connection available for unrelated request work. Every lock
// body reuses its checked-out session for SQL, so two concurrent media
// publications consume two of the three current pool slots rather than two
// locks plus two additional metadata connections.
const MAX_LOCAL_KEY_LOCKS = Math.max(1, POOL_MAX_PER_INSTANCE - 1);
let localKeyLocks = 0;
const localKeyLockWaiters: Array<() => void> = [];

async function acquireLocalKeyLockPermit(): Promise<void> {
	if (localKeyLocks < MAX_LOCAL_KEY_LOCKS) {
		localKeyLocks++;
		return;
	}
	await new Promise<void>((resolve) => {
		localKeyLockWaiters.push(() => {
			localKeyLocks++;
			resolve();
		});
	});
}

function releaseLocalKeyLockPermit(): void {
	localKeyLocks--;
	localKeyLockWaiters.shift()?.();
}

function databasePinnedToClient(
	client: import("pg").PoolClient,
	poolOptions: object,
): Kysely<AppDatabase> {
	const pinnedClient: PostgresPoolClient = {
		query: client.query.bind(client) as PostgresPoolClient["query"],
		// Kysely releases after each ordinary query/transaction. The outer key
		// lock owns the real checkout and releases it only after advisory unlock.
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
 * Serialize publication and last-reference cleanup for one canonical GCS key.
 *
 * This deliberately uses a dedicated checked-out session: session advisory
 * locks outlive SQL transactions, which lets the critical section span GCS and
 * Postgres without pretending those systems share a transaction. A hash
 * collision only over-serializes two unrelated keys; it cannot weaken safety.
 */
export async function withMediaObjectKeyLock<T>(
	gcsObjectKey: string,
	body: (lockedDb: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	await acquireLocalKeyLockPermit();
	try {
		const pool = await getCaseStorePool();
		const client = await pool.connect();
		let acquired = false;
		let lockedDb: Kysely<AppDatabase> | null = null;
		let discardClient: Error | undefined;
		let failed = false;
		let failure: unknown;
		let value!: T;
		try {
			try {
				await client.query(
					"SELECT pg_advisory_lock(hashtextextended($1, 0::bigint))",
					[gcsObjectKey],
				);
				acquired = true;
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
			if (acquired) {
				try {
					const result = await client.query<{ unlocked: boolean }>(
						"SELECT pg_advisory_unlock(hashtextextended($1, 0::bigint)) AS unlocked",
						[gcsObjectKey],
					);
					if (result.rows[0]?.unlocked !== true) {
						throw new Error(
							`Media object-key advisory unlock reported no held lock for ${gcsObjectKey}.`,
						);
					}
				} catch (error) {
					discardClient =
						error instanceof Error
							? error
							: new Error("Media object-key advisory unlock failed.");
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
		releaseLocalKeyLockPermit();
	}
}
