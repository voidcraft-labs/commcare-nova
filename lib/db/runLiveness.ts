import { MAX_GENERATION_MINUTES, MAX_RUN_MINUTES } from "./constants";
import type { AppDoc } from "./types";

/**
 * The SINGLE reader for run liveness / ownership / paused / settled state.
 *
 * Every credit/claim decision — claimRun's busy check, `reacquireLease`, both
 * reapers, the terminal WRITERS (`completeAndSettleRun` / `clearRunLockAndSettle` /
 * `settleAndRelease` / `failApp` / the flush `refundReservation`, which re-check
 * ownership IN THEIR TXN before mutating), the exact-holder pause/prelude writers
 * (`setAwaitingInput` / `clearRunLock`), the concurrency gate — derives from
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
 * missing or non-Date `expireAt` reads as EXPIRED (dead) rather than throwing —
 * the safe default for a corrupt lock is "not live", keeping the derivation
 * total. */
function lockExpired(
	lock: NonNullable<AppDoc["run_lock"]>,
	now: number,
): boolean {
	const ts = lock.expireAt as Date | undefined;
	if (typeof ts?.getTime !== "function") return true;
	return ts.getTime() <= now;
}

/** Whether a build's `updated_at` is inside the staleness window (a live build
 * advances it on every commit; a dead one goes quiet). A missing or non-Date
 * `updated_at` reads as NOT fresh (dead) rather than throwing — the safe default
 * for a corrupt/absent timestamp is "stale", and it keeps the derivation total. */
function generatingIsFresh(
	updatedAt: AppDoc["updated_at"] | undefined,
	now: number,
): boolean {
	const ts = updatedAt as Date | undefined;
	if (typeof ts?.getTime !== "function") return false;
	return now - ts.getTime() <= MAX_GENERATION_MINUTES * 60_000;
}

/**
 * The derived run-lease view of an app doc. Every field is a DECISION, not a raw
 * read — consumers branch on these, never on the underlying row fields.
 */
export interface RunHolderIdentity {
	readonly mode: "build" | "edit";
	readonly runId: string | null;
	/** Concrete on every nonce-capable claim. Null denotes a legacy v0 holder:
	 * compatibility mode may admit/reap it by mode + run id so rollout can drain
	 * it, but post-cutover exact nonce authority can never match it. */
	readonly nonce: string | null;
}

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
	/**
	 * Exact database holder identity. A reserved build is identified only by
	 * its reservation run id; the root `run_id` fallback applies solely to the
	 * pre-reservation generating shape. Missing/blank ids stay explicitly null
	 * so rollout census fails closed instead of inventing ownership.
	 */
	holderIdentity: RunHolderIdentity | null;
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
	 * paused run of either mode is alive-but-process-less. It BLOCKS another
	 * actor's claim (busy is `live || (paused && !pausedBy(claimant))` — a paused
	 * run is not a claimable takeover, but its OWN actor's new claim supersedes
	 * it); its own free-continuation resume re-enters it via `reacquireLease`,
	 * and an ABANDONED one is freed by the reapers once its lease lapses
	 * (`reapable*` key on the lapsed lease, not on `paused`).
	 */
	paused: boolean;
	/**
	 * Whether the PAUSED run occupying the app belongs to `actorUserId` — the
	 * same-actor supersede gate in `claimAndReserveRun`'s busy check. A paused
	 * run is alive-but-process-less, and its ask card may be unreachable
	 * entirely (a reload opens a fresh conversation), so when its OWN actor
	 * sends a new chargeable instruction the pause is abandoned — the claim
	 * supersedes it (refunding its unsettled hold to this same actor) instead
	 * of blocking behind a lease that can only lapse. The holder per mode
	 * mirrors the reapers' refund-actor rule: an edit's `run_lock.actorUserId`;
	 * a build's marker `userId`, falling back to `owner` for a migrated legacy
	 * marker. Always false when the app isn't paused — a LIVE run is never
	 * supersedable (that would kill an in-flight generation), and another
	 * actor's pause still blocks (their answer round is theirs to finish).
	 */
	pausedBy: (actorUserId: string) => boolean;
	/**
	 * Whether `runId` OWNS the occupying run. Edit: `run_lock.runId === runId`.
	 * Build: the reservation marker's `runId === runId` (a build has no lock to
	 * carry an id), NON-LENIENT — a marker with NO `runId` is owned by NOBODY. That
	 * is the reaper-race discriminator: a live run's marker carries its `runId`
	 * (`debitAndBookReservation` writes it), and the REAPERS CLEAR the `runId` when they
	 * resolve a stranded run. So a settled/present marker that still carries a
	 * `runId` is a run owning its own outcome (its terminal writer's `failApp` is
	 * correct), while a `runId`-cleared marker is a reaped GHOST — `mine` returns
	 * false, so the ghost's stale terminal writer can't `failApp` a taker that
	 * re-claimed the freed app. A migrated
	 * legacy marker may also lack a `runId` and is likewise unowned by `mine`.
	 * An edit can still reap a legacy marker because its concrete lock identifies
	 * the holder; a build with no concrete marker/root identity fails closed as
	 * corrupt rather than letting `(build, null)` target a later corrupt holder.
	 */
	mine: (runId: string) => boolean;
	/**
	 * Whether `runId` may perform its TERMINAL marker/lock write here — the shared
	 * ownership gate for all three terminal writers (`completeAndSettleRun` /
	 * `clearRunLockAndSettle` / `settleAndRelease`) and the flush `refundReservation`,
	 * so they can't diverge. A run owns its app until it terminates, so on the happy
	 * path this is trivially true; it guards the ONE surviving race
	 * — a long no-commit BUILD whose `updated_at` went stale mid-run is REAPED
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
	 *  - `none`  → `false` — an absent holder proves no caller identity. Orphan
	 *    markers are resolved only by a canonical reaper carrying the exact
	 *    identity it scanned; a terminal writer never gets a tokenless bypass.
	 */
	terminalWriteOwned: (runId: string) => boolean;
	/**
	 * Whether a BUILD may stamp its terminal error. Unlike marker settlement,
	 * this remains true after this run's marker was settled so the subsequent
	 * status flip can land. A just-created build may fail before reservation;
	 * only that marker-absent shape falls back to the root `run_id`. A reaper
	 * clears the marker run id and a replacement claim writes a new one, so a
	 * stale build cannot fail its successor.
	 */
	buildFailureWriteOwned: (runId: string) => boolean;
	/**
	 * Whether `runId` still owns the PAUSED run `actorUserId` is RESUMING — keyed
	 * on the resume's OWN mode, not the doc's derived `mode`. Both modes require
	 * the exact holder, `awaiting_input`, and the pause's original actor. A live
	 * same-run request is not a free continuation, and a co-member cannot forge
	 * another actor's paused run id. A reap or replacement claim destroys at
	 * least one of these facts, so a superseded resume bails and touches nothing.
	 * Keyed on the RESUME's mode (not the derived one) so it reads the right
	 * discriminator even when the app was re-claimed in the OTHER mode.
	 */
	ownedByResume: (
		runId: string,
		resumeMode: "build" | "edit",
		actorUserId: string,
		holderNonce: string | null,
		enforceNonce: boolean,
	) => boolean;
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
	 * and a re-claimant's claim books a fresh marker carrying its own
	 * — so this shape is the reaper's signature. Combined with `mode: "none"` +
	 * `status: "error"` by the build completion's FALSE-REAP SELF-HEAL: a live
	 * build reaped mid-run (a lapsed clock) that then finishes cleanly flips the
	 * reaper's `error` back to `complete` instead of celebrating over a
	 * failed-looking row (the reaper's refund stands — the build is kept free).
	 */
	reaperResolved: boolean;
	/**
	 * A hard-killed EDIT with a stranded, unsettled hold — the edit reaper's target
	 * (complete + an unsettled marker + a concrete `run_lock` present-and-lapsed).
	 * The lock-present requirement distinguishes a stranded edit from a BUILD's
	 * (lock-less) kept charge, which its clean completion already settled.
	 */
	reapableStrandedEdit: boolean;
	/**
	 * A hard-killed OR abandoned-paused BUILD — the build reaper's target:
	 * `mode: "build"` (status `generating`) whose `updated_at` fell outside the
	 * staleness window. `paused` is deliberately NOT excluded: a paused build has
	 * no heartbeat, so an ABANDONED one (the user never answered, the tab closed)
	 * drifts past the window and must be reaped or it would hold the app forever
	 * — while a recently-paused build's clock is still fresh and a resumed one
	 * re-arms it via `reacquireLease`. The build analogue of
	 * {@link reapableStrandedEdit}, so `reapStaleGenerating` /
	 * `refundStaleGeneration` re-validate the SAME derivation in-transaction
	 * (closing the TOCTOU where a fresh build re-claims between the scan and the
	 * refund). NOT gated on a reservation marker — a marker-less dead build with
	 * a concrete root `run_id` still reaps to `error` (its refund is then a no-op).
	 * A build missing both identities is corrupt and fails closed.
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
	const normalizedRunId = (value: string | null | undefined): string | null =>
		typeof value === "string" && value.length > 0 ? value : null;
	const holderIdentity: RunLease["holderIdentity"] =
		mode === "build"
			? {
					mode,
					runId: normalizedRunId(
						reservation === undefined ? fresh.run_id : reservation.runId,
					),
					nonce: normalizedRunId(fresh.run_holder_nonce),
				}
			: mode === "edit"
				? {
						mode,
						runId: normalizedRunId(lock?.runId),
						nonce: normalizedRunId(fresh.run_holder_nonce),
					}
				: null;
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
			// resolved (its stale terminal writer must NOT failApp a taker's
			// re-claim). A marker ALWAYS carries a runId once reserved
			// (`debitAndBookReservation` writes it); an absent runId is
			// either a migrated legacy marker or a reaped ghost — neither is "mine".
			// A build whose present identity is missing also cannot be canonically
			// reaped: null is corrupt state, not a replacement-safe token.
			return reservation?.runId === runId;
		}
		return false;
	};

	const pausedBy = (actorUserId: string): boolean => {
		if (!paused) return false;
		// The pause's actor, per mode — the same identity the reapers refund:
		// an edit's lock actor; a build's charged marker actor (owner for a
		// migrated legacy marker). An unresolvable holder never matches, so a
		// corrupt shape blocks rather than hands the app over.
		const holder =
			mode === "edit"
				? lock?.actorUserId
				: (reservation?.userId ?? fresh.owner);
		return holder !== undefined && holder !== "" && holder === actorUserId;
	};

	const markerSettleable = !!reservation && !reservation.settled;
	// The reaper's signature: settled marker, runId CLEARED (only the reaper
	// refunds clear it; every other writer keeps or freshly books it).
	const reaperResolved =
		!!reservation && !!reservation.settled && reservation.runId === undefined;

	const terminalWriteOwned = (runId: string): boolean => {
		if (mode === "edit") return mine(runId); // lock runId — authoritative
		if (mode === "build") return markerSettleable && mine(runId); // unsettled marker
		return false; // no holder means no caller can prove terminal ownership
	};

	const buildFailureWriteOwned = (runId: string): boolean => {
		if (mode !== "build") return false;
		if (reservation !== undefined) return reservation.runId === runId;
		return fresh.run_id === runId;
	};

	const ownedByResume = (
		runId: string,
		resumeMode: "build" | "edit",
		actorUserId: string,
		holderNonce: string | null,
		enforceNonce: boolean,
	): boolean => {
		return (
			mode === resumeMode &&
			paused &&
			mine(runId) &&
			(!enforceNonce ||
				(holderNonce !== null && holderIdentity?.nonce === holderNonce)) &&
			pausedBy(actorUserId)
		);
	};

	// A stranded EDIT hold to reap: `complete`, an unsettled marker, and a
	// `run_lock` PRESENT but PAST its lease. Reaps a HARD-KILLED edit AND an
	// ABANDONED PAUSED edit — a paused run has no heartbeat, so its lease lapses
	// ~MAX_RUN_MINUTES after its last activity; once lapsed, an abandoned paused
	// edit (the user never answered, the tab closed) must be freed so a waiter
	// can proceed (another actor's pause BLOCKS their claim, so it can't be left
	// holding forever; only the pause's own actor supersedes it sooner).
	// A recently-paused edit whose lease is still future is NOT reaped (lock in the
	// future), and its own resume `reacquireLease`s and renews. `awaiting_input` is
	// NOT excluded here — the lapsed lease is the reap signal, paused or not.
	// The marker and the lapsed lock need NOT belong to the same run: the atomic
	// claim+reserve books a fresh marker with every claim, so new data never
	// produces the split shape — but MIGRATED legacy rows can carry a prior run's
	// unsettled marker under a different run's lapsed lock, and a same-run
	// clause would make that orphan shape permanently unreapable. A lapsed lock
	// plus an unsettled marker means BOTH runs are dead, whoever each was; the
	// refund targets the marker's own charged actor.
	const reapableStrandedEdit =
		fresh.status === "complete" &&
		holderIdentity !== null &&
		holderIdentity.mode === "edit" &&
		holderIdentity.runId !== null &&
		markerSettleable &&
		!!lock &&
		lockExpired(lock, now);

	// A hard-killed OR abandoned-paused BUILD to reap: `generating` whose
	// `updated_at` fell outside the staleness window. A LIVE non-paused build keeps
	// advancing `updated_at` (fresh → not reaped); a PAUSED build's clock is frozen,
	// so an abandoned one drifts past the window ~MAX_GENERATION_MINUTES after its
	// last activity and is reaped (a resumed-in-time paused build re-arms
	// `updated_at` via `reacquireLease`, so it stays fresh). `paused` is NOT excluded
	// — the stale clock is the reap signal.
	const reapableStaleBuild =
		holderIdentity !== null &&
		holderIdentity.mode === "build" &&
		holderIdentity.runId !== null &&
		!generatingIsFresh(fresh.updated_at, now);

	return {
		mode,
		holderIdentity,
		present,
		live,
		paused,
		pausedBy,
		mine,
		terminalWriteOwned,
		buildFailureWriteOwned,
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
