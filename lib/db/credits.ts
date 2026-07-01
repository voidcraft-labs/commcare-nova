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
import { collections, docs } from "./firestore";
import { getCurrentPeriod } from "./period";
import type { AppDoc, CreditMonthDoc } from "./types";

/**
 * gRPC status code for Firestore's `RESOURCE_EXHAUSTED` write throttle. Firestore
 * returns it — "this database has exceeded their maximum bandwidth for writes" —
 * when a write burst outruns the database's current (ramp-up) write capacity or
 * hotspots a monotonically-indexed field (every ledger write stamps an
 * auto-indexed `serverTimestamp`), and it asks the client to retry with
 * exponential backoff. These transactions are on the request's critical path —
 * an unretried throttle hard-fails the user's build/edit with "credit
 * reservation failed" — so they ride it out instead of surfacing it.
 */
const FIRESTORE_RESOURCE_EXHAUSTED = 8;

/** Backoff schedule for the write-throttle retry — ~8s across four retries, well
 * under the chat route's ceiling, giving the database time to ramp up. */
const WRITE_THROTTLE_RETRY_DELAYS_MS = [250, 750, 2000, 5000];

function isFirestoreWriteThrottled(err: unknown): boolean {
	if (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === FIRESTORE_RESOURCE_EXHAUSTED
	) {
		return true;
	}
	const message = err instanceof Error ? err.message : String(err);
	return /RESOURCE_EXHAUSTED|maximum bandwidth for writes|rateLimitExceeded/i.test(
		message,
	);
}

/**
 * Run a credit-ledger transaction, retrying ONLY Firestore's write throttle
 * (`RESOURCE_EXHAUSTED`) with exponential backoff. Every other error propagates
 * immediately — `OutOfCreditsError` (a business rejection, not a throttle) and
 * contention `ABORTED` (which `runTransaction` already retries internally) must
 * not be swallowed here.
 */
async function withWriteThrottleRetry<T>(run: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (
		let attempt = 0;
		attempt <= WRITE_THROTTLE_RETRY_DELAYS_MS.length;
		attempt++
	) {
		try {
			return await run();
		} catch (err) {
			if (
				attempt === WRITE_THROTTLE_RETRY_DELAYS_MS.length ||
				!isFirestoreWriteThrottled(err)
			) {
				throw err;
			}
			lastError = err;
			await new Promise((resolve) =>
				setTimeout(resolve, WRITE_THROTTLE_RETRY_DELAYS_MS[attempt]),
			);
		}
	}
	throw lastError;
}

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
 * `userId` is the charged actor). Co-committing the
 * marker with the debit is load-bearing: it guarantees a charge can never land
 * without the marker the refunding reaper needs, so a hard kill after the debit
 * still has a durable record to refund. The app doc is written over its raw ref
 * for the same parse-on-read reason the credit doc is. The app doc always exists
 * here — `createApp` (build) or the existing app (edit) precedes the reservation.
 */
export async function reserveCredits(
	userId: string,
	cost: number,
	appId: string,
): Promise<Reservation> {
	const period = getCurrentPeriod();
	const ref = docs.creditMonthRaw(userId, period);
	const appRef = docs.appRaw(appId);

	await withWriteThrottleRetry(() =>
		ref.firestore.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			// A `Partial` view: a partially-written doc may omit fields, and a missing
			// doc supplies none — both fall back to the per-quantity defaults below.
			const data = snap.exists
				? (snap.data() as Partial<CreditMonthDoc>)
				: undefined;
			const allowance = data?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
			const consumed = data?.consumed ?? 0;
			const bonus = data?.bonus ?? 0;

			if (allowance + bonus - consumed < cost) {
				throw new OutOfCreditsError();
			}

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
			tx.set(
				appRef,
				// `userId` records WHO was charged (the actor), so a refund returns
				// the hold to that user — not `app.owner`, which diverges from the
				// actor once a Project co-member runs the app.
				{ reservation: { period, reserved: cost, settled: false, userId } },
				{ merge: true },
			);
		}),
	);

	return { period, reserved: cost };
}

/**
 * Refund the credits a reservation booked AND atomically settle its durable
 * marker, so the same hold can never be handed back twice.
 *
 * One cross-document transaction over the app doc and the credit-month doc:
 * un-books `consumed` and flips `reservation.settled` together. That atomicity
 * is what lets the two refund callers — the live finalize path (`flush`) and the
 * stale-`generating` reaper — both invoke this without racing a double refund:
 * whichever lands first settles the marker; the other reads `settled` and
 * no-ops. Idempotent and self-describing — it reads the charged user (the
 * marker's `userId`, falling back to `owner` for pre-per-actor-billing
 * markers), period, and amount off the marker, so callers pass only `appId`.
 *
 * No-ops cleanly when there is nothing to do: an absent marker (a free
 * continuation, or an app created before reservations shipped), an
 * already-`settled` marker, or a missing owner. The `consumed` decrement is
 * clamped at 0 (`creditMonthDocSchema` rejects negatives); a never-debited month
 * has no credit doc to un-book, but the marker is still settled so the reaper
 * stops revisiting it. Runs over the raw refs for the same parse-on-read reason
 * the reservation does.
 */
export async function refundReservation(appId: string): Promise<void> {
	const appRef = docs.appRaw(appId);

	await withWriteThrottleRetry(() =>
		appRef.firestore.runTransaction(async (tx) => {
			// All reads precede all writes (Firestore's transaction rule): read the
			// marker, then — only if there is something to refund — the credit doc.
			const appSnap = await tx.get(appRef);
			if (!appSnap.exists) return;
			const appData = appSnap.data() as Partial<AppDoc>;
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
		}),
	);
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

	await withWriteThrottleRetry(() =>
		monthRef.firestore.runTransaction(async (tx) => {
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
		}),
	);
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

	await withWriteThrottleRetry(() =>
		monthRef.firestore.runTransaction(async (tx) => {
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
		}),
	);
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
