/**
 * Credit ledger — the SERVER side of the credit gate (Firestore transactions).
 *
 * The pure constants and cost rules live in `./creditPolicy` (dependency-free,
 * client-safe); all the IO — reserving, and later refunding/resetting/granting
 * — lives here behind Firestore transactions. This module reads
 * `MONTHLY_CREDIT_ALLOWANCE` from the policy so the seeded allowance can never
 * drift from the amount the gate and the dashboards quote.
 */
import { FieldValue } from "@google-cloud/firestore";
import { creditBalance, MONTHLY_CREDIT_ALLOWANCE } from "./creditPolicy";
import { collections, docs, runThrottledTransaction } from "./firestore";
import { withFirestoreRetry } from "./firestoreRetry";
import { getCurrentPeriod } from "./period";
import { runLeaseState } from "./runLiveness";
import type { AppDoc, CreditMonthDoc } from "./types";

/**
 * Thrown by `reserveCredits` when the user's remaining balance can't cover the
 * charge. The chat route catches this specific type and maps it to a 429 with
 * the out-of-credits message; every other failure inside the reservation is an
 * infrastructure fault the route fails closed on (503). The message is the
 * human-readable reason surfaced to that mapping.
 */
export class OutOfCreditsError extends Error {
	constructor() {
		super("Out of credits for this period");
		this.name = "OutOfCreditsError";
	}
}

/**
 * The booked reservation handed back to the route, then threaded into the
 * usage accumulator so a no-op or failed run can refund the exact charge
 * against the exact month it hit.
 */
export interface Reservation {
	/**
	 * The period the charge was booked against. Threaded to the refund so a
	 * flush that crosses midnight into a new month still refunds the month that
	 * was actually debited, not whatever `getCurrentPeriod()` reads at flush time.
	 */
	period: string;
	/** Credits reserved (a build's 100 or an edit's 5) — refunded verbatim on a no-op. */
	reserved: number;
}

/**
 * Reserve `cost` credits for the current period before a generation runs.
 *
 * Runs over the converter-less raw ref (`docs.creditMonthRaw`): a
 * `withConverter` read routes through `schema.parse`, which would throw inside
 * the transaction on a partially-initialized existing doc (the same hazard the
 * run-summary writer documents). Reading raw and supplying defaults in code
 * sidesteps that.
 *
 * The flow is read-check-write, all inside one transaction:
 *   1. Read the current balance components (or full-allowance defaults if the
 *      period has no doc yet — a never-touched month reads as a fresh 2000).
 *   2. Reject with `OutOfCreditsError` if the spendable balance can't cover the
 *      cost. The check happens against the value just read, so a concurrent
 *      reservation that lands between this read and this write loses on the
 *      transaction's abort-and-retry on contention: the server SDK takes read
 *      locks and ABORTs one of two contending transactions ("Too much
 *      contention"), then retries the loser, whose re-read sees the depleted
 *      balance and rejects — rather than overspending.
 *   3. Write the seeded doc: explicit `allowance`/`bonus` (so a missing doc is
 *      fully materialized — `allowance` has no Zod default) and a LITERAL
 *      `consumed + cost`. The literal (not `FieldValue.increment`) is essential:
 *      it is the value the balance was checked against, so the gate can reject
 *      over-budget atomically; an `increment` sentinel would commit blindly and
 *      defeat the cap under contention.
 *
 * The same transaction also stamps the DURABLE RESERVATION MARKER onto the app
 * doc (`reservation: { period, reserved, settled:false, userId }`, where
 * `userId` is the charged actor). Co-committing the marker with the debit is
 * load-bearing: it guarantees a charge can never land without the marker the
 * refunding reaper needs, so a hard kill after the debit still has a durable
 * record to refund. The app doc is written over its raw ref for the same
 * parse-on-read reason the credit doc is. The app doc always exists here —
 * `createApp` (build) or the existing app (edit) precedes the reservation.
 *
 * The marker carries NO `expireAt`: liveness is the `run_lock`'s single horizon
 * (refreshed per commit), which the edit reaper keys on — a second
 * reservation-side horizon would diverge from it (a live long edit refreshes the
 * lock but not the reservation) and claw back a live charge. Any stale
 * `reservation.expireAt` a legacy marker carried is scrubbed on this write.
 *
 * At most one run holds an app at a time (`claimRun` serializes builds and
 * edits), so the single marker is never contended by two LIVE runs. A marker
 * CAN survive its run: a hard-killed edit stays `complete` with an unsettled
 * marker until `reapStaleReservation` reaches it, and the NEXT run could reserve
 * before that reap fires. So this refunds a leftover UNSETTLED marker
 * UNCONDITIONALLY before overwriting it — refund-first, off the marker's own
 * `userId`/`period`. Unconditional because the caller only reaches here after
 * WINNING `claimRun`, so any unsettled marker present is a superseded run's
 * stranded hold. A settled or absent marker has nothing to refund.
 */
export async function reserveCredits(
	userId: string,
	cost: number,
	appId: string,
	runId: string,
): Promise<Reservation> {
	const period = getCurrentPeriod();
	const ref = docs.creditMonthRaw(userId, period);
	const appRef = docs.appRaw(appId);

	await runThrottledTransaction(ref.firestore, async (tx) => {
		// Read every doc up front — Firestore forbids a read after the first
		// write. The app doc carries any leftover marker to refund; the prior
		// actor's credit doc (if the leftover is for a DIFFERENT month/user) is
		// read only when there is a stranded hold to un-book.
		const snap = await tx.get(ref);
		const appSnap = await tx.get(appRef);
		const appData = appSnap.exists
			? (appSnap.data() as Partial<AppDoc>)
			: undefined;
		const prior = appData?.reservation;
		// "Is there an unsettled hold to refund" is a settled-state decision — read
		// it through the one reader, never a raw `prior.settled`.
		const priorSettleable = appData
			? runLeaseState(appData).markerSettleable
			: false;

		/* A leftover UNSETTLED marker is a superseded run's STRANDED hold — this
		 * caller only reaches here after WINNING `claimRun`, and at-most-one-run
		 * holds an app, so any marker still present is a dead/superseded run's, not
		 * a live one. Un-book it UNCONDITIONALLY before this run's fresh marker
		 * overwrites it, so the prior actor's credits can't be silently buried. NOT
		 * gated on the leftover's own `expireAt`: the waiter that just won was
		 * unblocked by the prior run's `run_lock.expireAt` (stamped a few ms
		 * EARLIER at `claimRun` than that run's `reservation.expireAt`), so an
		 * expireAt gate would lose the refund in the band between the two expiries.
		 * Refund off the marker's OWN actor/period — the per-actor targeting
		 * `refundReservation` uses. When the prior hold hit THIS run's own credit
		 * doc (the common same-user, same-month re-edit), it folds into the single
		 * debit below as `consumed − prior.reserved + cost` rather than a second
		 * racing write to the same doc; a leftover on a DIFFERENT doc gets its own
		 * deferred write. */
		let refundPriorOther: (() => void) | undefined;
		let priorRefundSameDoc = 0;
		if (prior && priorSettleable) {
			const priorUser = prior.userId ?? appData?.owner;
			if (priorUser) {
				const priorRef = docs.creditMonthRaw(priorUser, prior.period);
				if (priorRef.path === ref.path) {
					// Same doc as this reservation — subtract from the working balance.
					priorRefundSameDoc = prior.reserved;
				} else {
					const priorSnap = await tx.get(priorRef);
					if (priorSnap.exists) {
						const priorConsumed =
							(priorSnap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
						refundPriorOther = () =>
							tx.set(
								priorRef,
								{
									consumed: Math.max(0, priorConsumed - prior.reserved),
									updated_at: FieldValue.serverTimestamp(),
								},
								{ merge: true },
							);
					}
				}
			}
		}

		// A `Partial` view: a partially-written doc may omit fields, and a missing
		// doc supplies none — both fall back to the per-quantity defaults below.
		const data = snap.exists
			? (snap.data() as Partial<CreditMonthDoc>)
			: undefined;
		const allowance = data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
		// Working consumed already nets out a same-doc leftover refund, so the
		// affordability check and the debit both reason about the post-refund
		// balance (a stranded prior hold on this doc must not count against this
		// run's spend).
		const consumed = Math.max(0, (data?.consumed ?? 0) - priorRefundSameDoc);
		const bonus = data?.bonus ?? 0;

		if (allowance + bonus - consumed < cost) {
			throw new OutOfCreditsError();
		}

		refundPriorOther?.();

		// Re-write allowance/bonus alongside the incremented consumed so a merge
		// onto a missing or partial doc always leaves a complete, parseable record.
		tx.set(
			ref,
			{
				allowance,
				bonus,
				consumed: consumed + cost,
				updated_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);

		// Durable reservation marker, committed atomically with the debit above.
		// `userId` records WHO was charged (the actor), so a refund returns the
		// hold to that user — not `app.owner`, which diverges from the actor once a
		// Project co-member runs the app. `runId` records WHICH run booked it — the
		// per-run BUILD-ownership identity `mine` reads (a build has no `run_lock`
		// to carry one). Writing it here is what lets a settled marker still carrying
		// a `runId` mean "a live run owns its outcome" vs a reaper-cleared `runId`
		// meaning "a reaped ghost" (the reaper-race discriminator). `expireAt` is CLEARED
		// with `FieldValue.delete()` (not omitted): liveness is the `run_lock`'s
		// single horizon, so the marker carries no expireAt of its own — and because
		// `set(..., { merge: true })` deep-merges the nested `reservation` map, a
		// legacy marker's stale `expireAt` would otherwise be INHERITED (Firestore
		// keeps nested keys the new data omits). The explicit delete scrubs it.
		tx.set(
			appRef,
			{
				reservation: {
					period,
					reserved: cost,
					settled: false,
					userId,
					runId,
					expireAt: FieldValue.delete(),
				},
			},
			{ merge: true },
		);
	});

	return { period, reserved: cost };
}

/**
 * Refund the credits a reservation booked AND atomically settle its durable
 * marker, so the same hold can never be handed back twice — the FLUSH path's
 * refund (a failed / zero-cost run un-booking its OWN hold).
 *
 * OWNERSHIP-GATED: acts ONLY if `runId` still OWNS the app
 * (`runLeaseState().terminalWriteOwned`). It no-ops when a DIFFERENT run owns the
 * app — the reaper-race that survives without a barge: this run's lease lapsed and
 * it was REAPED (its hold refunded, its marker settled), and the freed app was
 * re-claimed by another run whose `reserveCredits` wrote a fresh marker; `mine` is
 * false, so this can't claw the new run's live marker.
 *
 * One cross-document transaction over the app doc and the credit-month doc:
 * un-books `consumed` and flips `reservation.settled` together, idempotent via
 * `settled`. Self-describing — it reads the charged user (the marker's `userId`,
 * falling back to `owner` for pre-per-actor-billing markers), period, and amount
 * off the marker.
 *
 * No-ops cleanly when there is nothing to do: not-mine (a re-claimed app), an
 * absent marker (a free continuation, or a pre-reservations app), an
 * already-`settled` marker, or a missing owner. The `consumed` decrement is clamped at 0
 * (`creditMonthDocSchema` rejects negatives). Runs over the raw refs for the same
 * parse-on-read reason the reservation does.
 */
export async function refundReservation(
	appId: string,
	runId: string,
): Promise<void> {
	const appRef = docs.appRaw(appId);

	await runThrottledTransaction(appRef.firestore, async (tx) => {
		// All reads precede all writes (Firestore's transaction rule): read the
		// marker, then — only if there is something to refund — the credit doc.
		const appSnap = await tx.get(appRef);
		if (!appSnap.exists) return;
		const appData = appSnap.data() as Partial<AppDoc>;
		// OWNERSHIP GATE — refund only when THIS run still owns the app (via the
		// shared `terminalWriteOwned`: edit → lock runId; build → unsettled-marker
		// runId; none → a bare stranded marker on a `complete`/no-lock app, no
		// competing run). A run that was reaped + the app re-claimed is skipped, so
		// this can't claw the new run's marker.
		const lease = runLeaseState(appData);
		if (!lease.terminalWriteOwned(runId)) return;
		const reservation = appData.reservation;
		// Refund the user who was CHARGED — the run's actor, recorded on the
		// marker. Pre-per-actor-billing markers carry no `userId`; fall back to
		// `owner` (the actor in the single-member world those were written in).
		// Using `owner` unconditionally would refund the wrong user once a
		// Project co-member's run is the one being unbooked.
		const chargedUserId = reservation?.userId ?? appData.owner;
		if (!reservation || reservation.settled || !chargedUserId) return;

		const creditRef = docs.creditMonthRaw(chargedUserId, reservation.period);
		const creditSnap = await tx.get(creditRef);

		if (creditSnap.exists) {
			const consumed =
				(creditSnap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
			tx.set(
				creditRef,
				{
					consumed: Math.max(0, consumed - reservation.reserved),
					updated_at: FieldValue.serverTimestamp(),
				},
				{ merge: true },
			);
		}

		tx.set(
			appRef,
			{ reservation: { ...reservation, settled: true } },
			{ merge: true },
		);
	});
}

/**
 * The FAILED-run terminal writer: refund-if-unsettled + settle the reservation
 * marker AND (for an edit) release the `run_lock` — in ONE transaction.
 *
 * This handles the strand where a failed run refunded
 * (settling the marker) then, SEPARATELY, cleared the lock gated on "did my
 * refund call return" — so a refund that threw after `flush` had already settled
 * the marker left the lock cleared-attempt skipped while the marker was settled,
 * and the reaper (which needs an UNSETTLED marker) could no longer reap it → the
 * lock stranded for the full lease. Doing both in one txn makes the pairing
 * "lock cleared + marker unsettled" impossible BY CONSTRUCTION: the lock is
 * released ONLY inside the same commit that settles the marker, so if the txn
 * commits the marker is settled, and if it throws NOTHING changed (the lock stays
 * for the reaper). No second independent refund, no "settled vs cleared" skew.
 *
 * OWNERSHIP-GATED at write time — the RETURN and the WRITE are two distinct
 * decisions. "Is the app MINE (or unowned)?" is `mode: "none" ||
 * mine(runId)`: on the common failed-run path this is TRUE (the run still owns its
 * marker's `runId`), so the RETURN `settled: true` fires the route's build
 * `failApp`. It is FALSE for a REAPER-GHOST: a long no-commit BUILD went stale
 * mid-run, was REAPED (marker settled + its `runId` CLEARED), and the freed app
 * RE-CLAIMED by another run before this write. The reaper's `runId`-clear is the
 * disambiguation — non-lenient `mine(runId)` on the cleared marker is false, so
 * this NO-OPS and returns `{ settled: false }`, and the route does NOT flip the
 * taker's app to `error`. (A NORMAL flush-settled failed build keeps its `runId` →
 * still mine → `failApp` fires, correctly.) The failing run's own hold, if any, was
 * already refunded by its `flush` before this runs.
 *
 * `releaseLock` deletes the `run_lock` (an EDIT failure — a build has none, so it
 * passes `false`). The WRITE settles only an UNSETTLED marker (`flush` may have
 * pre-settled it) and releases the lock together, in the same commit — idempotent,
 * no-op-on-absent/settled, refund targeting identical to {@link refundReservation}.
 * Returns whether this run's credit is RESOLVED + the app is ours (`settled`) —
 * `false` only when a different run owns it, a missing doc, or a read failure that
 * returns without committing, so the route never `failApp`s an app it lost.
 */
export async function settleAndRelease(
	appId: string,
	runId: string,
	opts: { releaseLock: boolean },
): Promise<{ settled: boolean }> {
	const appRef = docs.appRaw(appId);
	// Bounded transient-retry, like the CLEAN writers (`completeAndSettleRun` /
	// `clearRunLockAndSettle`): a failed EDIT's lock is released in this same txn,
	// so a transient Firestore blip that made a single attempt throw would strand
	// the lock (a collaborator lockout until the lease lapses) — the retry lands it.
	return await withFirestoreRetry(() =>
		runThrottledTransaction(appRef.firestore, async (tx) => {
			const appSnap = await tx.get(appRef);
			if (!appSnap.exists) return { settled: false };
			const appData = appSnap.data() as Partial<AppDoc>;
			const lease = runLeaseState(appData);
			const reservation = appData.reservation;

			// OWNERSHIP — two DISTINCT questions:
			//
			//  - "Is the app MINE (or unowned)?" `mode: "none"` OR `mine(runId)`. On the
			//    common failed-run path this is TRUE (the run still owns its marker's
			//    `runId`). It is FALSE for a REAPER-GHOST: a long no-commit build that
			//    went stale mid-run was REAPED (its marker settled + `runId` CLEARED) and
			//    the freed app re-claimed before this write — so non-lenient `mine(runId)`
			//    on the runId-cleared marker is false, this NO-OPs, and returns
			//    `settled: false` so the route won't flip the taker's app to `error`. (A
			//    NORMAL flush-settled failed build keeps its `runId`, so it stays mine.)
			//  - "Is my run's credit RESOLVED — safe for the route to `failApp`?" This
			//    is the RETURN, and it is `ownedByMe`: when the app is mine, this call
			//    settles any unsettled hold below, so on return the credit is resolved
			//    WHETHER `flush` settled it first (`!markerSettleable`) or this call
			//    did. Conflating "resolved" with "I wrote a settle" (gating the return
			//    on `markerSettleable && mine`) returns `false` for a
			//    flush-pre-settled failed build → the route skipped `failApp` → the
			//    build sat `generating` until the staleness reaper.
			//
			// The "should I WRITE the settle" sub-decision is the `!reservation.settled`
			// guard inside the app-doc write — only an UNSETTLED marker is touched.
			const ownedByMe = lease.mode === "none" || lease.mine(runId);
			if (!ownedByMe) return { settled: false };

			const chargedUserId = reservation?.userId ?? appData.owner;
			// Refund the unsettled hold to the charged actor (same targeting as
			// `refundReservation`). A marker already settled (by this POST's `flush`)
			// or absent needs no credit write — but the lock still releases below.
			if (reservation && !reservation.settled && chargedUserId) {
				const creditRef = docs.creditMonthRaw(
					chargedUserId,
					reservation.period,
				);
				const creditSnap = await tx.get(creditRef);
				if (creditSnap.exists) {
					const consumed =
						(creditSnap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
					tx.set(
						creditRef,
						{
							consumed: Math.max(0, consumed - reservation.reserved),
							updated_at: FieldValue.serverTimestamp(),
						},
						{ merge: true },
					);
				}
			}

			// The app-doc write: settle the marker (only if UNSETTLED) AND release the
			// lock (if asked) — TOGETHER, so the lock never clears while the marker is
			// unsettled. `merge: true` leaves status / blueprint untouched. Skip the
			// write entirely when there's nothing to do (marker already settled + no
			// lock to release) so a flush-pre-settled build writes nothing here.
			const settleField =
				reservation && !reservation.settled
					? { reservation: { ...reservation, settled: true } }
					: undefined;
			const releaseField = opts.releaseLock
				? { run_lock: FieldValue.delete() }
				: undefined;
			if (settleField || releaseField) {
				tx.set(appRef, { ...settleField, ...releaseField }, { merge: true });
			}
			return { settled: true };
		}),
	);
}

/**
 * Refund a STRANDED edit hold — the edit reaper's transactional refund, with the
 * staleness re-validated INSIDE the transaction.
 *
 * `reapStaleReservation` reads the row OUT of transaction to decide the app is
 * worth reaping. Plain `refundReservation` would then re-read + un-book any
 * unsettled marker it finds — but between the reaper's read and its refund txn a
 * fresh edit can win the expired lock and `reserveCredits` refunds the leftover +
 * writes its own unsettled marker (the live run's charge). Refunding that with
 * plain `refundReservation` would claw back a live in-lease charge.
 *
 * So this re-reads the row in the txn and un-books ONLY if it is STILL a
 * genuinely-dead stranded edit hold — `runLeaseState().reapableStrandedEdit`, the
 * SAME derivation the `reapStaleReservation` pre-filter and `projectAppSummary`
 * key on, so the guard can't drift. That derivation folds in every check: complete
 * + unsettled marker + a `run_lock` PRESENT but PAST its refreshed `expireAt` + the
 * marker and lock belonging to the same dead run (lenient on a legacy no-runId
 * marker). It reaps a HARD-KILLED edit AND an ABANDONED PAUSED one — a paused run
 * has no heartbeat, so its lease lapses; an abandoned paused edit must be freed so
 * a waiter can proceed (a paused run BLOCKS in the descoped model). A LIVE edit
 * refreshes `run_lock.expireAt` off activity, and a paused run's OWN resume
 * `reacquireLease`s + renews, so only a run whose lease actually lapsed is reaped —
 * a future `expireAt` is always skipped. The full guard living HERE (not just in
 * the caller's pre-filter) makes the "never reap a live lease" invariant
 * self-contained. Otherwise identical to `refundReservation` (per-actor targeting,
 * clamp-at-0, settle atomically), idempotent via `settled`.
 */
export async function refundStaleReservation(appId: string): Promise<void> {
	const appRef = docs.appRaw(appId);

	await runThrottledTransaction(appRef.firestore, async (tx) => {
		const appSnap = await tx.get(appRef);
		if (!appSnap.exists) return;
		const appData = appSnap.data() as Partial<AppDoc>;
		if (!runLeaseState(appData).reapableStrandedEdit) return;
		// `reapableStrandedEdit` proved the marker present + unsettled + the lock is
		// this dead run's; refund to the charged actor.
		const reservation = appData.reservation as NonNullable<
			AppDoc["reservation"]
		>;
		const chargedUserId = reservation.userId ?? appData.owner;
		if (!chargedUserId) return;

		const creditRef = docs.creditMonthRaw(chargedUserId, reservation.period);
		const creditSnap = await tx.get(creditRef);
		if (creditSnap.exists) {
			const consumed =
				(creditSnap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
			tx.set(
				creditRef,
				{
					consumed: Math.max(0, consumed - reservation.reserved),
					updated_at: FieldValue.serverTimestamp(),
				},
				{ merge: true },
			);
		}

		// Settle the marker AND RELEASE the lapsed `run_lock` in the same commit. A
		// stranded edit's lock is a hard-killed run's — clearing it is what stops a
		// PERSISTENTLY-stranded lock (e.g. a clean settle+release that kept hitting a
		// transient fault) from blocking every collaborator for the full lease: the
		// reaper both hands the hold back AND makes the app claimable. `reapableStrandedEdit`
		// already proved the lock is present + lapsed, so deleting it can't drop a
		// live lease. Clearing the marker's `runId` too is the reaper-race fix: the
		// reaped run's own stale terminal writer must not read this marker as `mine`.
		// It rides a NESTED partial with an explicit `FieldValue.delete()` (NOT an omit):
		// `set(..., {merge:true})` deep-merges the reservation map, so a rebuild that
		// merely omitted `runId` would leave the old one intact. `userId`/`period`/
		// `reserved` survive so refund targeting + idempotency hold.
		tx.set(
			appRef,
			{
				reservation: { settled: true, runId: FieldValue.delete() },
				run_lock: FieldValue.delete(),
				awaiting_input: FieldValue.delete(),
			},
			{ merge: true },
		);
	});
}

/**
 * Reap a hard-killed BUILD: refund the stranded hold + flip `generating → error`
 * in ONE transaction, with the staleness RE-VALIDATED inside it — the build
 * analogue of {@link refundStaleReservation}.
 *
 * `reapStaleGenerating` fires this off a `listApps` / `hasActiveGeneration` scan
 * that decided the row LOOKS like a hard-killed build. But that scan is
 * out-of-transaction, so between it and the refund a FRESH build can re-claim the
 * app (`claimRun('build')` re-arms `updated_at` + writes a fresh marker) — a plain
 * `refundReservation` + `failApp` would then claw the live build's charge and
 * brick it (`generating → error`). This re-reads in the txn and acts ONLY if the
 * row is STILL `runLeaseState().reapableStaleBuild` (a `generating` row past its
 * `updated_at` window, not paused); a re-claimed build reads live and this
 * no-ops. Refund + settle + the `status → error` flip all commit TOGETHER, so no
 * fresh run can slip between the refund and the flip either.
 *
 * Idempotent: a second reap of an already-`error` row reads `mode: "none"` (not
 * `generating`) → `reapableStaleBuild` false → no-op. Refund targeting +
 * clamp-at-0 mirror `refundReservation`; a marker-less dead build still flips to
 * `error` with no credit write. Returns nothing — fire-and-forget at the caller.
 */
export async function refundStaleGeneration(appId: string): Promise<void> {
	const appRef = docs.appRaw(appId);
	await runThrottledTransaction(appRef.firestore, async (tx) => {
		const appSnap = await tx.get(appRef);
		if (!appSnap.exists) return;
		const appData = appSnap.data() as Partial<AppDoc>;
		// Re-validate IN THE TXN: only a still-hard-killed build is reaped.
		if (!runLeaseState(appData).reapableStaleBuild) return;

		const reservation = appData.reservation;
		const chargedUserId = reservation?.userId ?? appData.owner;
		if (reservation && !reservation.settled && chargedUserId) {
			const creditRef = docs.creditMonthRaw(chargedUserId, reservation.period);
			const creditSnap = await tx.get(creditRef);
			if (creditSnap.exists) {
				const consumed =
					(creditSnap.data() as Partial<CreditMonthDoc>).consumed ?? 0;
				tx.set(
					creditRef,
					{
						consumed: Math.max(0, consumed - reservation.reserved),
						updated_at: FieldValue.serverTimestamp(),
					},
					{ merge: true },
				);
			}
		}
		// Refund (settle the marker), flip to `error`, clear `awaiting_input`, AND
		// clear the marker's `runId` in the SAME commit — a fresh build can't re-claim
		// between them. Clearing `awaiting_input` handles an ABANDONED PAUSED build (its
		// frozen clock drifted past the window) — without it the reaped app would be
		// `error` + still flagged paused with no run. Clearing `runId` is the reaper-race
		// fix: this marker is now the reaper's, not a live run's, so its `runId` must NOT
		// survive for the reaped run's own stale terminal writer to read as `mine` and
		// `failApp` a taker that re-claimed the freed app in the [claim, reserveCredits)
		// window. The settle rides a NESTED partial (`{settled, runId: delete}`), NOT a
		// whole-object rebuild: `set(..., {merge:true})` DEEP-merges the reservation map,
		// so a rebuilt object that merely OMITS `runId` would leave the old one intact
		// (the same nested-merge trap `reserveCredits` scrubs `expireAt` for) — an
		// explicit `FieldValue.delete()` is what actually removes it. `userId`/`period`/
		// `reserved` survive; `settled: true` is the idempotency guard. An
		// already-settled/absent marker is left as-is (nothing to refund or clear).
		const settleField =
			reservation && !reservation.settled
				? { reservation: { settled: true, runId: FieldValue.delete() } }
				: undefined;
		tx.set(
			appRef,
			{
				status: "error",
				error_type: "internal",
				awaiting_input: FieldValue.delete(),
				...settleField,
			},
			{ merge: true },
		);
	});
}

/**
 * The acting admin behind a reset/grant, recorded on the audit row. Exported as
 * the single source of truth for this shape so the admin write-route (which
 * builds it from the session) and these writers agree on the field names —
 * `actorEmail` is the admin's denormalized email stored as `actor_email` for the
 * audit display; `reason` is the optional free-text justification.
 */
export interface AdminActor {
	/** Acting admin's userId. */
	actor: string;
	/** Acting admin's email, denormalized onto the audit row. */
	actorEmail: string;
	/** Free-text justification, or null when the admin gave none. */
	reason: string | null;
}

/**
 * Reset a user's current-period credits: zero `consumed` and append an audit
 * row recording who did it and why — both in ONE transaction so the effect and
 * its audit commit together (or not at all).
 *
 * Read-then-seed is load-bearing: a reset on a user with NO current-period doc
 * must still write a COMPLETE doc. `allowance` has no Zod default by design
 * (its value is credit policy, not schema), so a partial `{ consumed: 0 }` merge
 * would leave a doc the next converter-applied read (the summary, the admin
 * dashboard) throws on. So we seed `allowance` from the existing value or the
 * monthly default, preserve any prior `bonus`, and zero `consumed`. The audit
 * row records `amount: 0` — a reset zeroes consumed and grants nothing.
 */
export async function resetCredits(
	userId: string,
	who: AdminActor,
): Promise<void> {
	const period = getCurrentPeriod();
	const monthRef = docs.creditMonthRaw(userId, period);
	// A fresh auto-id ref for the append-only audit row, minted before the
	// transaction so the same ref is written exactly once inside it.
	const grantRef = collections.creditGrants(userId).doc();

	await runThrottledTransaction(monthRef.firestore, async (tx) => {
		const snap = await tx.get(monthRef);
		const data = snap.exists
			? (snap.data() as Partial<CreditMonthDoc>)
			: undefined;

		// Seed a complete doc: explicit allowance (no Zod default), preserved
		// bonus, consumed zeroed.
		tx.set(
			monthRef,
			{
				allowance: data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
				consumed: 0,
				bonus: data?.bonus ?? 0,
				updated_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);

		// Audit row, written in the same transaction so the comp is always
		// traceable to an actor. No merge: each grant ref is a fresh document.
		tx.set(grantRef, {
			amount: 0,
			type: "reset",
			actor: who.actor,
			actor_email: who.actorEmail,
			reason: who.reason,
			period,
			created_at: FieldValue.serverTimestamp(),
		});
	});
}

/**
 * Grant a user bonus credits for the current period and append an audit row —
 * both in ONE transaction so the effect and its audit commit together.
 *
 * A grant ADDS to `bonus` and must never write `consumed`: writing consumed
 * (even to 0) would silently erase the period's usage, turning a grant into a
 * reset. The merge therefore omits `consumed` entirely so the on-disk value is
 * preserved. Read-then-seed seeds `allowance` for the same complete-doc reason
 * as the reset; `bonus` accumulates onto any prior bonus.
 */
export async function grantCredits(
	userId: string,
	amount: number,
	who: AdminActor,
): Promise<void> {
	const period = getCurrentPeriod();
	const monthRef = docs.creditMonthRaw(userId, period);
	const grantRef = collections.creditGrants(userId).doc();

	await runThrottledTransaction(monthRef.firestore, async (tx) => {
		const snap = await tx.get(monthRef);
		const data = snap.exists
			? (snap.data() as Partial<CreditMonthDoc>)
			: undefined;

		// Seed allowance (complete-doc guard), add to bonus, and deliberately do
		// NOT write consumed so the on-disk usage is preserved by the merge.
		tx.set(
			monthRef,
			{
				allowance: data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
				bonus: (data?.bonus ?? 0) + amount,
				updated_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);

		tx.set(grantRef, {
			amount,
			type: "grant",
			actor: who.actor,
			actor_email: who.actorEmail,
			reason: who.reason,
			period,
			created_at: FieldValue.serverTimestamp(),
		});
	});
}

/**
 * A user's current-period balance plus their lifetime credits consumed. The
 * shape the user-facing usage endpoint and the admin dashboard both render.
 */
export interface CreditSummary {
	/** The current `yyyy-mm` period the balance figures describe. */
	period: string;
	/** Current period's monthly grant. */
	allowance: number;
	/** Current period's debited credits. */
	consumed: number;
	/** Current period's additive admin grants. */
	bonus: number;
	/** Spendable now: `allowance + bonus − consumed`. */
	balance: number;
	/** Credits consumed across every period the user has ever had a doc for. */
	lifetimeConsumed: number;
}

/**
 * Read a user's current balance and lifetime credits consumed.
 *
 * Reads every credit-month doc through the converter (these are complete,
 * on-disk docs — the parse-on-read hazard only bites the reservation's
 * mid-transaction read of a possibly-partial doc, not a settled collection
 * read), summing `consumed` across all of them for `lifetimeConsumed` and
 * pulling the current period's components out for the balance. A user with no
 * current-period doc reads as a fresh full allowance — the same absent-doc =
 * full-balance rule the gate uses — without forcing a pre-seeding write.
 */
export async function getCreditSummary(userId: string): Promise<CreditSummary> {
	const period = getCurrentPeriod();
	const monthsSnap = await collections.creditMonths(userId).get();

	let lifetimeConsumed = 0;
	let current: CreditMonthDoc | undefined;
	for (const monthDoc of monthsSnap.docs) {
		const data = monthDoc.data();
		lifetimeConsumed += data.consumed;
		if (monthDoc.id === period) current = data;
	}

	const allowance = current?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
	const consumed = current?.consumed ?? 0;
	const bonus = current?.bonus ?? 0;
	return {
		period,
		allowance,
		consumed,
		bonus,
		balance: allowance + bonus - consumed,
		lifetimeConsumed,
	};
}

/**
 * Read ONLY the current period's spendable balance — the hot-path read the chat
 * gate runs on every chargeable POST.
 *
 * Deliberately distinct from `getCreditSummary`: the summary reads the user's
 * ENTIRE credit-months collection to sum `lifetimeConsumed`, which the gate
 * never needs. This touches a single doc (the current-period balance) and
 * returns just the number, so a chargeable request pays one O(1) read instead
 * of an O(months) collection scan. The dashboards keep `getCreditSummary`.
 *
 * Reads through the CONVERTER ref (not the raw transaction ref): a settled,
 * non-transactional doc is always complete — every writer here writes
 * `allowance` explicitly — so the parse-on-read hazard that the reservation's
 * mid-transaction raw read guards against doesn't apply. An absent doc reads as
 * a full allowance via `creditBalance(undefined)`, the same absent-doc =
 * full-balance rule the gate and dashboard share.
 */
export async function getCurrentCreditBalance(userId: string): Promise<number> {
	const snap = await docs.creditMonth(userId, getCurrentPeriod()).get();
	return creditBalance(snap.exists ? snap.data() : undefined);
}
