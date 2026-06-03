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
import { MONTHLY_CREDIT_ALLOWANCE } from "./creditPolicy";
import { docs } from "./firestore";
import { getCurrentPeriod } from "./period";
import type { CreditMonthDoc } from "./types";

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
 */
export async function reserveCredits(
	userId: string,
	cost: number,
): Promise<Reservation> {
	const period = getCurrentPeriod();
	const ref = docs.creditMonthRaw(userId, period);

	await ref.firestore.runTransaction(async (tx) => {
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
	});

	return { period, reserved: cost };
}
