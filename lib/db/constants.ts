// lib/db/constants.ts
//
// Shared numeric constants for the multiplayer mutation stream's retention and
// the presence/dedup TTLs. This leaf imports only the browser-safe, validated
// runtime manifest projection — never `apps.ts` / `credits.ts` (which would
// cycle, since those import each other through the reservation/usage paths).

import {
	BUILD_STALENESS_SECONDS,
	EDIT_RUN_LEASE_SECONDS,
} from "@/lib/runtimeCapabilities";

/**
 * How many `acceptedMutations/{seq}` deltas to retain per app: entries older
 * than `head − RETENTION_COUNT` are pruned, so a client whose recovery cursor
 * falls below that window reloads the full blueprint rather than replaying
 * deltas. Sized so an ordinary editing session never overruns the window
 * between reconnects.
 */
export const RETENTION_COUNT = 500;

/**
 * Nominal ~7-day TTL floor for an `accepted_mutations` entry, sitting beneath
 * the count-bounded retention (`RETENTION_COUNT`). The `accepted_mutations` log
 * is retained permanently today (no prune), so this value backs no active
 * sweep.
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
 * Renewable edit-run liveness lease length, in minutes. Every heartbeat and
 * guarded commit extends `run_lock.expireAt` to `now + this duration`; it is the
 * quiet horizon after which an unsettled edit reservation may be treated as
 * stranded (`reapStaleReservation`), never a total runtime bound.
 *
 * Distinct from the build path's staleness inference, which keys on `updated_at`
 * advancing (a live build refreshes it on every commit) rather than a fixed
 * lease: a long-but-live build must never be reaped, so builds keep the
 * `updated_at`-window rule (`reapStaleGenerating`) and edits — which stay
 * `complete` and so never advance `updated_at` for the reaper to key on — use
 * this renewable lease instead. An edit may run across arbitrarily many
 * renewals, including after its initiating browser request disconnects; the
 * independent Cloud Run request cap therefore says nothing about holder drain.
 * The authored duration lives in the runtime-capability manifest.
 */
export const MAX_RUN_MINUTES = EDIT_RUN_LEASE_SECONDS / 60;

/**
 * Build-run staleness window, in minutes — how long a `generating` app may go
 * without its `updated_at` advancing before the run is inferred hard-killed.
 *
 * A live build advances `updated_at` on every commit, so a genuinely-running
 * build stays inside this window; a `generating` row that has gone quiet longer
 * than this is a dead process the next claim displaces (`reapStaleGenerating`;
 * `runLeaseState().live` is false for it). This is the BUILD analogue of
 * {@link MAX_RUN_MINUTES}'s edit lease — the build-mode liveness horizon
 * `runLiveness.ts` reads.
 *
 * The authored duration lives in the runtime-capability manifest and remains
 * independent from both the request cap and stream-lease TTL.
 */
export const MAX_GENERATION_MINUTES = BUILD_STALENESS_SECONDS / 60;
