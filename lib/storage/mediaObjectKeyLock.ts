import "server-only";

import type { Kysely } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { withSessionAdvisoryLocks } from "@/lib/db/sessionAdvisoryLock";
import { mediaObjectLockIdentity } from "./mediaObjectIdentity";

export { mediaObjectLockIdentity } from "./mediaObjectIdentity";

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
	const lockIdentities = gcsObjectKeys.map(mediaObjectLockIdentity);
	if (lockIdentities.length === 0) {
		throw new Error(
			"withMediaObjectKeyLocks requires at least one media object key.",
		);
	}
	return withSessionAdvisoryLocks(lockIdentities, "Media content", body);
}

/** Serialize one canonical media content identity. */
export async function withMediaObjectKeyLock<T>(
	gcsObjectKey: string,
	body: (lockedDb: Kysely<AppDatabase>) => Promise<T>,
): Promise<T> {
	return withMediaObjectKeyLocks([gcsObjectKey], body);
}
