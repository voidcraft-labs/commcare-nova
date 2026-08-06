import "server-only";

import type { Kysely } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { withSessionAdvisoryLocks } from "@/lib/db/sessionAdvisoryLock";

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
