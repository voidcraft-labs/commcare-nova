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
 * The advisory-lock identity for a media object.
 *
 * Validated final objects use `projects/<project>/<sha256><extension>`, while a
 * document extract uses the same Project/hash without the source extension.
 * The identical UTF-8 bytes can validly arrive as either `.txt` or `.md`, so
 * locking the full base-object key would let those rows race on their shared
 * extract object. Collapse every valid content-addressed final/extract key to
 * the extension-independent Project/hash identity. Pending upload keys stay
 * per-attempt and therefore retain their exact identity.
 */
export function mediaObjectLockIdentity(gcsObjectKey: string): string {
	const match = /^(projects\/[^/]+\/[0-9a-f]{64})(?:\..+)$/.exec(gcsObjectKey);
	return match?.[1] ?? gcsObjectKey;
}

/**
 * Serialize publication and last-reference cleanup for canonical media content
 * identities. Every identity is acquired on one checked-out session in sorted
 * order and released in reverse order. Cross-Project relocation needs both its
 * source and destination identities at once: sorting here gives every caller
 * the same lock order and prevents source-A/destination-B from deadlocking a
 * source-B/destination-A move.
 *
 * This deliberately uses a dedicated checked-out session: session advisory
 * locks outlive SQL transactions, which lets the critical section span GCS and
 * Postgres without pretending those systems share a transaction. A hash
 * collision only over-serializes two unrelated keys; it cannot weaken safety.
 */
export async function withMediaObjectKeyLocks<T>(
	gcsObjectKeys: readonly string[],
	body: (lockedDb: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	const lockIdentities = [
		...new Set(gcsObjectKeys.map(mediaObjectLockIdentity)),
	].sort();
	if (lockIdentities.length === 0) {
		throw new Error(
			"withMediaObjectKeyLocks requires at least one media object key.",
		);
	}
	await acquireLocalKeyLockPermit();
	try {
		const pool = await getCaseStorePool();
		const client = await pool.connect();
		const acquiredIdentities: string[] = [];
		let lockedDb: Kysely<AppDatabase> | null = null;
		let discardClient: Error | undefined;
		let failed = false;
		let failure: unknown;
		let value!: T;
		try {
			try {
				for (const lockIdentity of lockIdentities) {
					await client.query(
						"SELECT pg_advisory_lock(hashtextextended($1, 0::bigint))",
						[lockIdentity],
					);
					acquiredIdentities.push(lockIdentity);
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
			for (let index = acquiredIdentities.length - 1; index >= 0; index--) {
				const lockIdentity = acquiredIdentities[index];
				try {
					const result = await client.query<{ unlocked: boolean }>(
						"SELECT pg_advisory_unlock(hashtextextended($1, 0::bigint)) AS unlocked",
						[lockIdentity],
					);
					if (result.rows[0]?.unlocked !== true) {
						throw new Error(
							`Media content advisory unlock reported no held lock for ${lockIdentity}.`,
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

/** Serialize one canonical media content identity. */
export async function withMediaObjectKeyLock<T>(
	gcsObjectKey: string,
	body: (lockedDb: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	return withMediaObjectKeyLocks([gcsObjectKey], body);
}
