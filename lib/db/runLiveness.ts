import type { Timestamp } from "@google-cloud/firestore";
import { MAX_GENERATION_MINUTES, MAX_RUN_MINUTES } from "./constants";
import type { AppDoc } from "./types";

/**
 * The SINGLE reader for run liveness / ownership / paused / settled state.
 *
 * Every credit/claim decision — claimRun's busy check, `reacquireLease`, both
 * reapers, the terminal WRITERS (`completeAndSettleRun` / `clearRunLockAndSettle` /
 * `settleAndRelease` / the flush `refundReservation`, which re-check ownership IN
 * THEIR TXN before mutating), the concurrency gate — derives from
 * {@link runLeaseState}. NO other module reads `run_lock.expireAt`,
 * `run_lock.runId`, or `reservation.runId` for a decision (a build-time grep guard
 * fails on a raw read of those three PURE fields outside this file; see
 * `runLivenessGrepGuard.test.ts`). `reservation.settled` is read only by the
 * atomic writers' settle-WRITES (not hard-guarded), and `status` / `awaiting_input`
 * have legitimate non-liveness readers (the UI, status transitions, the build page),
 * so those are NOT hard-guarded — but the credit/claim decision modules route their
 * liveness/paused reads of them through here too.
 *
 * The single-reader invariant is the structural fix for a read-layer divergence
 * class: "is this run alive / mine / paused / owed-a-settle" was computed
 * INDEPENDENTLY at ~10 sites reading different field subsets, so they diverged. Its
 * symmetric WRITE side: a terminal writer RE-CHECKS ownership in its transaction and
 * NO-OPs when a different run owns the app (the reaper-race — a stale run reaped +
 * the freed app re-claimed). A new path physically cannot diverge — no raw field to
 * read — so it consumes the same derived booleans everyone else does.
 */

/** A `run_lock` deadline that has passed (a hard-killed edit's lapsed lease). A
 * missing or non-Timestamp `expireAt` reads as EXPIRED (dead) rather than
 * throwing — the safe default for a corrupt lock is "not live", keeping the
 * derivation total. */
function lockExpired(
	lock: NonNullable<AppDoc["run_lock"]>,
	now: number,
): boolean {
	const ts = lock.expireAt as Timestamp | undefined;
	if (typeof ts?.toDate !== "function") return true;
	return ts.toDate().getTime() <= now;
}

/** Whether a build's `updated_at` is inside the staleness window (a live build
 * advances it on every commit; a dead one goes quiet). A missing or non-Timestamp
 * `updated_at` reads as NOT fresh (dead) rather than throwing — the safe default
 * for a corrupt/absent timestamp is "stale", and it keeps the derivation total. */
function generatingIsFresh(
	updatedAt: AppDoc["updated_at"] | undefined,
	now: number,
): boolean {
	const ts = updatedAt as Timestamp | undefined;
	if (typeof ts?.toDate !== "function") return false;
	return now - ts.toDate().getTime() <= MAX_GENERATION_MINUTES * 60_000;
}

/**
 * The derived run-lease view of an app doc. Every field is a DECISION, not a raw
 * read — consumers branch on these, never on the underlying Firestore leaves.
 */
export interface RunLease {
	/**
	 * What kind of run occupies the app:
	 *  - `"build"` — `status: 'generating'` (a build holds via status, no lock);
	 *  - `"edit"` — a `run_lock` present (an edit holds via its lease, status stays
	 *    `complete`);
	 *  - `"none"` — `complete` with no `run_lock` (claimable by anyone).
	 * A build's `generating` takes precedence over a stale leftover lock (a build
	 * claim deletes the lock), so `mode` keys on status first.
	 */
	mode: "build" | "edit" | "none";
	/** A run occupies the app at all (build `generating`, or an edit `run_lock`). */
	present: boolean;
	/**
	 * The run is LIVE — present and not hard-killed. A build is live inside its
	 * `updated_at` staleness window; an edit is live while its `run_lock.expireAt`
	 * is in the future (a live edit refreshes it off activity). The single
	 * per-mode liveness horizon, read in ONE place.
	 */
	live: boolean;
	/**
	 * The run is PAUSED on an `askQuestions` round (present + `awaiting_input`). A
	 * paused run of either mode is alive-but-process-less. It BLOCKS a claim (busy is
	 * `live || paused` — a paused run is NOT a claimable takeover); its own
	 * free-continuation resume re-enters it via `reacquireLease`, and an ABANDONED
	 * one is freed by the reapers once its lease lapses (`reapable*` key on the
	 * lapsed lease, not on `paused`).
	 */
	paused: boolean;
	/**
	 * Whether `runId` OWNS the occupying run. Edit: `run_lock.runId === runId`.
	 * Build: the reservation marker's `runId === runId` (a build has no lock to
	 * carry an id), NON-LENIENT — a marker with NO `runId` is owned by NOBODY. That
	 * is the reaper-race discriminator: a live run's marker carries its `runId`
	 * (`reserveCredits` writes it), and the REAPERS CLEAR the `runId` when they
	 * resolve a stranded run. So a settled/present marker that still carries a
	 * `runId` is a run owning its own outcome (its terminal writer's `failApp` is
	 * correct), while a `runId`-cleared marker is a reaped GHOST — `mine` returns
	 * false, so the ghost's stale terminal writer can't `failApp` a taker that
	 * re-claimed the freed app in the `[claim, reserveCredits)` window. A legacy
	 * pre-P9 marker also lacks a `runId` and is likewise unowned by `mine`; both a
	 * ghost and a legacy marker are resolved by the reapers' OWN lenient clauses
	 * (`reapableStrandedEdit`/`reapableStaleBuild`), never through `mine`.
	 */
	mine: (runId: string) => boolean;
	/**
	 * Whether `runId` may perform its TERMINAL marker/lock write here — the shared
	 * ownership gate for all three terminal writers (`completeAndSettleRun` /
	 * `clearRunLockAndSettle` / `settleAndRelease`) and the flush `refundReservation`,
	 * so they can't diverge. A run owns its app until it terminates, so on the happy
	 * path this is trivially true; it guards the ONE race that remains without a
	 * barge — a long no-commit BUILD whose `updated_at` went stale mid-run is REAPED
	 * (flipped to `error` + settled) and the freed app RE-CLAIMED by another run
	 * before this run's terminal write lands; the gate makes that stale write no-op
	 * rather than clobber the new run. Per mode:
	 *  - `edit`  → `mine(runId)` — an edit's ownership is its `run_lock.runId`, an
	 *    authoritative per-run id; a re-claim overwrote it, so `mine` is false.
	 *  - `build` → `markerSettleable && mine(runId)` — a build has NO lock; its only
	 *    ownership discriminator is the marker's `runId` (`mine` is NON-LENIENT — a
	 *    reaped run's marker has its `runId` CLEARED → not mine). The UNSETTLED
	 *    requirement is a second, redundant guard: the reaper SETTLES the marker too,
	 *    so a reaped run's marker fails BOTH `markerSettleable` and `mine`. Every
	 *    build reaching a terminal write reserved, so a genuine live one has an
	 *    unsettled marker carrying its own `runId`.
	 *  - `none`  → `true` — no run occupies the app, so the caller's own stranded
	 *    hold is safe to resolve.
	 */
	terminalWriteOwned: (runId: string) => boolean;
	/**
	 * Whether `runId` still owns the PAUSED run it is RESUMING — keyed on the
	 * resume's OWN mode, not the doc's derived `mode`. A paused run's lease lapses
	 * while it waits for the user (no heartbeat during a pause), so it CAN be reaped
	 * mid-answer and the freed app claimed by another run. `ownedByResume` requires
	 * the app to STILL be in the shape the resume expects — which a reap + re-claim
	 * destroys — so a resume of a superseded run bails and touches nothing:
	 *  - `"edit"` resume → `mode === "edit" && mine` (its `run_lock.runId`); a reap
	 *    cleared the lock or a re-claim overwrote it (`mode` no longer edit / a
	 *    different runId) → not owned → bail.
	 *  - `"build"` resume → `mode === "build" && paused && mine` (a paused-build shape
	 *    with the marker's `runId`); a reap flipped it to `error` or a re-claim
	 *    cleared `awaiting_input` (not paused) → not owned → bail.
	 * Keyed on the RESUME's mode (not the derived one) so it reads the right
	 * discriminator even when the app was re-claimed in the OTHER mode.
	 */
	ownedByResume: (runId: string, resumeMode: "build" | "edit") => boolean;
	/**
	 * An unsettled reservation marker exists — a credit hold owed a settle/refund.
	 * The failure-path lock-clear and the reapers key on this, never on "my
	 * refund call returned".
	 */
	markerSettleable: boolean;
	/**
	 * The app's LAST run was resolved by a REAPER and nothing re-claimed since:
	 * a marker present, SETTLED, with its `runId` CLEARED. Only the two reaper
	 * refunds clear a marker's `runId` — a run's own terminal writers keep it,
	 * and a re-claimant's `reserveCredits` books a fresh marker carrying its own
	 * — so this shape is the reaper's signature. Combined with `mode: "none"` +
	 * `status: "error"` by the build completion's FALSE-REAP SELF-HEAL: a live
	 * build reaped mid-run (a lapsed clock) that then finishes cleanly flips the
	 * reaper's `error` back to `complete` instead of celebrating over a
	 * failed-looking row (the reaper's refund stands — the build is kept free).
	 */
	reaperResolved: boolean;
	/**
	 * A hard-killed EDIT with a stranded, unsettled hold — the edit reaper's target
	 * (complete + non-paused + an unsettled marker + a `run_lock` present-and-lapsed).
	 * The lock-present requirement distinguishes a stranded edit from a BUILD's
	 * (lock-less) kept charge, which its clean completion already settled.
	 */
	reapableStrandedEdit: boolean;
	/**
	 * A hard-killed BUILD — the build reaper's target: `mode: "build"` (status
	 * `generating`) that is neither live (its `updated_at` fell outside the window,
	 * the process is dead) nor paused (an `askQuestions` build is alive, awaiting
	 * the user). The build analogue of {@link reapableStrandedEdit}, so
	 * `reapStaleGenerating` / `refundStaleGeneration` re-validate the SAME
	 * derivation in-transaction (closing the TOCTOU where a fresh build re-claims
	 * between the scan and the refund). NOT gated on the marker — a marker-less dead
	 * build still reaps to `error` (its refund is then a no-op).
	 */
	reapableStaleBuild: boolean;
}

/**
 * Derive the {@link RunLease} from an app doc's run-state leaves. Pure; `now`
 * defaults to `Date.now()` and is injectable for tests. `Partial<AppDoc>` so the
 * raw converter-less reads (claims/reaps) and the parsed reads (summary) share it.
 */
export function runLeaseState(
	fresh: Partial<AppDoc>,
	now: number = Date.now(),
): RunLease {
	const lock = fresh.run_lock;
	const reservation = fresh.reservation;
	const awaitingInput = !!fresh.awaiting_input;

	const mode: RunLease["mode"] =
		fresh.status === "generating" ? "build" : lock ? "edit" : "none";
	const present = mode !== "none";
	const paused = present && awaitingInput;
	// Within the mode's liveness horizon (build: `updated_at` window; edit: the
	// `run_lock` lease). Keyed on `lock`/`status` directly so no non-null
	// assertion is needed — an edit is live iff its lock is present and unexpired.
	const withinHorizon =
		mode === "build"
			? generatingIsFresh(fresh.updated_at, now)
			: !!lock && !lockExpired(lock, now);
	const live = present && !paused && withinHorizon;

	const mine = (runId: string): boolean => {
		if (mode === "edit") return lock?.runId === runId;
		if (mode === "build") {
			// A build has no lock; ownership rides the reservation marker's runId,
			// which is NON-LENIENT: a marker with NO runId is owned by NOBODY. This is
			// what disambiguates a run that owns its outcome from a REAPED GHOST — the
			// reapers CLEAR a reaped marker's runId, so a settled marker still carrying
			// a runId is a run that will resolve itself (its terminal writer's failApp
			// is correct), while a runId-cleared marker is a run the reaper already
			// resolved (its stale terminal writer must NOT failApp the taker's re-claim
			// that landed in the [claim, reserveCredits) window). A marker ALWAYS carries
			// a runId once reserved (`reserveCredits` writes it); an absent runId is
			// either a legacy pre-P9 marker (resolved by the reapers' own lenient
			// clauses, never through `mine`) or a reaped ghost — neither is "mine".
			return reservation?.runId === runId;
		}
		return false;
	};

	const markerSettleable = !!reservation && !reservation.settled;
	// The reaper's signature: settled marker, runId CLEARED (only the reaper
	// refunds clear it; every other writer keeps or freshly books it).
	const reaperResolved =
		!!reservation && !!reservation.settled && reservation.runId === undefined;

	const terminalWriteOwned = (runId: string): boolean => {
		if (mode === "edit") return mine(runId); // lock runId — authoritative
		if (mode === "build") return markerSettleable && mine(runId); // unsettled marker
		return true; // mode "none": no run occupies the app
	};

	const ownedByResume = (
		runId: string,
		resumeMode: "build" | "edit",
	): boolean => {
		if (resumeMode === "edit") return mode === "edit" && mine(runId);
		return mode === "build" && paused && mine(runId);
	};

	// A stranded EDIT hold to reap: `complete`, an unsettled marker, and a
	// `run_lock` PRESENT but PAST its lease. Reaps a HARD-KILLED edit AND an
	// ABANDONED PAUSED edit — a paused run has no heartbeat, so its lease lapses
	// ~MAX_RUN_MINUTES after its last activity; once lapsed, an abandoned paused
	// edit (the user never answered, the tab closed) must be freed so a waiter can
	// proceed (a paused run BLOCKS in the descoped model, so it can't hold forever).
	// A recently-paused edit whose lease is still future is NOT reaped (lock in the
	// future), and its own resume `reacquireLease`s and renews. `awaiting_input` is
	// NOT excluded here — the lapsed lease is the reap signal, paused or not.
	const reapableStrandedEdit =
		fresh.status === "complete" &&
		markerSettleable &&
		!!lock &&
		lockExpired(lock, now) &&
		// The lapsed lock and the marker must belong to the same dead run. Lenient on
		// a legacy marker with no runId.
		(!reservation?.runId || reservation.runId === lock.runId);

	// A hard-killed OR abandoned-paused BUILD to reap: `generating` whose
	// `updated_at` fell outside the staleness window. A LIVE non-paused build keeps
	// advancing `updated_at` (fresh → not reaped); a PAUSED build's clock is frozen,
	// so an abandoned one drifts past the window ~MAX_GENERATION_MINUTES after its
	// last activity and is reaped (a resumed-in-time paused build re-arms
	// `updated_at` via `reacquireLease`, so it stays fresh). `paused` is NOT excluded
	// — the stale clock is the reap signal.
	const reapableStaleBuild =
		mode === "build" && !generatingIsFresh(fresh.updated_at, now);

	return {
		mode,
		present,
		live,
		paused,
		mine,
		terminalWriteOwned,
		ownedByResume,
		markerSettleable,
		reaperResolved,
		reapableStrandedEdit,
		reapableStaleBuild,
	};
}

/**
 * Lease-length in ms for a fresh/renewed EDIT `run_lock` — `now + MAX_RUN_MINUTES`.
 * The one place the lease deadline is computed, shared by claimRun's edit arm,
 * `refreshEditLease`, `reacquireLease`, and the per-commit refresh.
 */
export function editLeaseDeadlineMs(now: number = Date.now()): number {
	return now + MAX_RUN_MINUTES * 60_000;
}
