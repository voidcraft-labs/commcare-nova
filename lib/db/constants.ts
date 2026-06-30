// lib/db/constants.ts
//
// Shared numeric constants for the multiplayer mutation stream's retention,
// the presence/dedup TTLs, and the SA-run liveness bound. A deliberate
// dependency-free leaf so every consumer imports from here rather than
// redefining, and nothing here imports `apps.ts` / `credits.ts` (which would
// cycle, since those import each other through the reservation/usage paths).

/**
 * How many `acceptedMutations/{seq}` deltas to retain per app: entries older
 * than `head − RETENTION_COUNT` are pruned, so a client whose recovery cursor
 * falls below that window reloads the full blueprint rather than replaying
 * deltas. Sized so an ordinary editing session never overruns the window
 * between reconnects.
 */
export const RETENTION_COUNT = 500;

/**
 * TTL for an `acceptedMutations/{seq}` entry (~7 days). Set as an absolute
 * `expireAt` Timestamp at write time; a Firestore TTL policy provisioned
 * out-of-band on the `expireAt` field reaps expired entries. Retention is
 * primarily count-bounded (`RETENTION_COUNT`); the TTL is the durable floor
 * that sweeps an abandoned app's stream.
 */
export const ACCEPTED_MUTATIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TTL for a `presence/{userId}:{sessionId}` entry (~60 s). A tab heartbeats
 * well inside this window; a tab that stops heartbeating (closed, crashed)
 * has its presence reaped by the TTL policy on the `expireAt` field.
 */
export const PRESENCE_TTL_MS = 60 * 1000;

/**
 * TTL for a `batchDedup/{batchId}` idempotency latch (~1 h). Long enough to
 * absorb a client's retry of a not-yet-acked batch, short enough that the
 * latch collection stays small.
 */
export const BATCH_DEDUP_TTL_MS = 60 * 60 * 1000;

/**
 * Upper bound (minutes) on a single SA run's hold — the `expireAt` an edit
 * `run_lock` and a credit `reservation` carry. A `claimRun` treats a
 * `run_lock` past `expireAt` as claimable, and the edit reaper refunds a
 * stranded reservation only once it is past `expireAt`. Comfortably above
 * the build staleness window (`MAX_GENERATION_MINUTES`, 10) so a legitimately
 * long run is never reaped out from under itself.
 */
export const MAX_RUN_MINUTES = 15;
