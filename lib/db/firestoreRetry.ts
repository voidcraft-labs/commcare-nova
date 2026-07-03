/**
 * Bounded transient-retry for a Firestore transaction — the Firestore analogue of
 * `schemaSyncRetry.ts` (which is Postgres/SQLSTATE-keyed). The clean-completion
 * atomic writers (`completeAndSettleRun` / `clearRunLockAndSettle`) MUST reliably
 * settle+release: a transient Firestore blip that made a single attempt throw
 * would leave a clean edit's `run_lock` present with a fresh `expireAt` (a 15-min
 * collaborator lockout) and its kept charge exposed to the reaper. A bounded
 * retry absorbs the blip so the clean completion lands.
 *
 * `runTransaction` already retries ABORTED/contention INTERNALLY; this covers the
 * class it surfaces to the caller — a network / server-availability fault on the
 * whole call. The writers are ownership-gated + idempotent (a re-read that finds
 * the marker already settled / the lock already gone no-ops), so a retry that
 * duplicates a partially-applied attempt is safe.
 */

import { delay } from "@/lib/utils/delay";

const ATTEMPTS = 3;
const BACKOFF_MS = 150;

/**
 * gRPC status codes Firestore surfaces for a TRANSIENT fault worth retrying (the
 * numeric `error.code` on a `@google-cloud/firestore` error). A deterministic
 * fault (a Zod parse throw, a precondition failure) is a plain `Error` with no
 * numeric `code`, so it falls through as non-transient and rethrows immediately.
 * Conservative: an unrecognized error isn't retried.
 *   4  DEADLINE_EXCEEDED · 8 RESOURCE_EXHAUSTED · 10 ABORTED (contention that
 *   escaped the internal retry) · 13 INTERNAL · 14 UNAVAILABLE
 */
const TRANSIENT_GRPC_CODES: ReadonlySet<number> = new Set([4, 8, 10, 13, 14]);

/** Whether `error` (or its wrapped `cause`) is a transient Firestore/gRPC fault. */
export function isTransientFirestoreError(error: unknown): boolean {
	const layers = [
		error,
		(error as { cause?: unknown } | null | undefined)?.cause,
	];
	for (const layer of layers) {
		const code = (layer as { code?: unknown } | null | undefined)?.code;
		if (typeof code === "number" && TRANSIENT_GRPC_CODES.has(code)) return true;
	}
	return false;
}

/**
 * Run `attempt`, retrying only TRANSIENT Firestore failures up to `ATTEMPTS`. A
 * deterministic error rethrows on the first attempt (no wasted backoff). Returns
 * `attempt`'s value so an ownership-gated writer can report whether it acted.
 */
export async function withFirestoreRetry<T>(
	attempt: () => Promise<T>,
): Promise<T> {
	for (let i = 1; i <= ATTEMPTS; i++) {
		try {
			return await attempt();
		} catch (error) {
			if (i >= ATTEMPTS || !isTransientFirestoreError(error)) throw error;
			await delay(BACKOFF_MS * i);
		}
	}
	// Unreachable — the loop either returns or throws on the final attempt.
	throw new Error("[withFirestoreRetry] exhausted without a terminal outcome");
}
