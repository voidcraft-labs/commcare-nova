/**
 * Integration tests for the credit ledger's transactional reservation against
 * a real Firestore emulator. The unit suite (`credits.test.ts`) drives a
 * scripted transaction with spies; this file exercises the genuine
 * runTransaction round-trip, which proves the read-check-write commits and
 * reads back as a complete, correctly-defaulted on-disk document.
 *
 * What this proves that the unit suite can't:
 *   - `reserveCredits` against a real, never-seen user creates
 *     `credits/{userId}/months/{period}` with `consumed` equal to the cost and
 *     a full allowance seeded — the genuine first-write path through Firestore's
 *     `set(..., { merge: true })`, not a spied stand-in.
 *   - A second affordable reservation decrements further; a reservation that
 *     exceeds the remaining balance throws and leaves the on-disk doc
 *     UNCHANGED (the rejected charge books nothing).
 *
 * Why the multi-writer CONCURRENCY race is NOT here: both the server SDK
 * (`@google-cloud/firestore`, what production runs against a Standard-edition
 * database) and the emulator take read locks on a transactional read — they are
 * pessimistic, not optimistic compare-and-set. The difference is what each does
 * when two single-doc transactions contend. Production cleanly ABORTs one ("Too
 * much contention") and the SDK retries it; the retry re-reads the depleted
 * balance and rejects. The EMULATOR's `ReactiveLockManager` instead LIVELOCKS
 * the pair — each holds a read lock while awaiting the other's write lock — and
 * churns "Transaction lock timeout → ABORTED → SDK retry" for ~30s rather than
 * resolving to one winner and one rejection (confirmed in `firestore-debug.log`
 * and by a 30s test timeout). The emulator cannot model the clean abort-and-retry
 * the race was meant to assert. That contention path — the aborted loser is
 * retried and its re-read rejects — is instead exercised deterministically
 * against the REAL `reserveCredits` closure in `credits.test.ts` ("rejects on a
 * transaction retry whose re-read shows the balance newly depleted"), which
 * re-runs the closure with the depleted snapshot the SDK's retry would observe.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset — run via
 * `npm run test:integration`, which boots the emulator and exports the host.
 */

import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	CREDITS_PER_BUILD,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_PROJECT_ID = "demo-test";
const TEST_USER_ID = "user-credit-integration";

/**
 * Read the raw credit-month doc for the test user's current period. Reads via
 * a converter-less path (the reservation writes raw `DocumentData`), returning
 * `undefined` when the doc doesn't exist — mirroring how the gate treats an
 * untouched period as a full balance.
 */
async function readCreditMonth(
	db: Firestore,
	period: string,
): Promise<{ allowance: number; consumed: number; bonus: number } | undefined> {
	const snap = await db
		.collection("credits")
		.doc(TEST_USER_ID)
		.collection("months")
		.doc(period)
		.get();
	if (!snap.exists) return undefined;
	const data = snap.data() as {
		allowance?: number;
		consumed?: number;
		bonus?: number;
	};
	return {
		allowance: data.allowance ?? 0,
		consumed: data.consumed ?? 0,
		bonus: data.bonus ?? 0,
	};
}

/** Delete the test user's whole credit-month subcollection between cases. */
async function clearCreditMonths(db: Firestore): Promise<void> {
	const snap = await db
		.collection("credits")
		.doc(TEST_USER_ID)
		.collection("months")
		.get();
	await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/**
 * Seed the test user's current-period credit doc to a precise balance so a
 * case can place the user exactly at the affordability boundary it needs.
 */
async function seedCreditMonth(
	db: Firestore,
	period: string,
	doc: { allowance: number; consumed: number; bonus: number },
): Promise<void> {
	await db
		.collection("credits")
		.doc(TEST_USER_ID)
		.collection("months")
		.doc(period)
		.set({ ...doc, updated_at: new Date() });
}

describe.skipIf(!emulatorAvailable)("reserveCredits integration", () => {
	let db: Firestore;
	const period = getCurrentPeriod();

	beforeAll(() => {
		initializeApp({ projectId: TEST_PROJECT_ID });
		// Our own client for seed/clear/read-back. The production `getDb()` inside
		// `reserveCredits` connects to the SAME emulator via the host env var.
		db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
	});

	afterAll(async () => {
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearCreditMonths(db);
	});

	it("creates the month doc with a full allowance and the booked cost on a first reservation", async () => {
		const { reserveCredits } = await import("../credits");

		const result = await reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD);
		expect(result).toEqual({ period, reserved: CREDITS_PER_BUILD });

		// A complete doc must land — explicit allowance (it has no Zod default),
		// zero bonus, and consumed = the cost just booked.
		const after = await readCreditMonth(db, period);
		expect(after).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
	});

	it("decrements further on a second reservation, then rejects an unaffordable one without mutating the doc", async () => {
		const { OutOfCreditsError, reserveCredits } = await import("../credits");

		// Two affordable builds in sequence: consumed walks 100 → 200.
		await reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD);
		await reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD);
		expect((await readCreditMonth(db, period))?.consumed).toBe(
			2 * CREDITS_PER_BUILD,
		);

		// Now seed the user to the brink: 5 spendable, charging 100 must reject.
		await seedCreditMonth(db, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
		await expect(
			reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(OutOfCreditsError);

		// The rejected reservation booked nothing — the doc is exactly as seeded.
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
	});
});
