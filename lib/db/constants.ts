// lib/db/constants.ts
//
// Shared numeric constants for the multiplayer mutation stream's retention and
// the presence/dedup TTLs. A deliberate dependency-free leaf so every consumer
// imports from here rather than redefining, and nothing here imports `apps.ts`
// / `credits.ts` (which would cycle, since those import each other through the
// reservation/usage paths).

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
