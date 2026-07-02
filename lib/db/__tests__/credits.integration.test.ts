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
const TEST_APP_ID = "app-credit-integration";

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
 * Delete the test user's whole append-only grants subcollection between cases.
 * Grants never get overwritten in production — each intervention appends a fresh
 * doc — so without this clear the rows would accumulate across cases and make a
 * "read back exactly one grant row" assertion count stale rows from earlier
 * tests.
 */
async function clearCreditGrants(db: Firestore): Promise<void> {
	const snap = await db
		.collection("credits")
		.doc(TEST_USER_ID)
		.collection("grants")
		.get();
	await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/**
 * Read back every grant audit row for the test user, newest interventions last
 * (unordered — the cases assert on count and on the single row's contents, not
 * on ordering). Returns the raw stored shape so a case can pin `type`/`amount`/
 * `actor` exactly as written.
 */
async function readCreditGrants(db: Firestore): Promise<
	Array<{
		amount: number;
		type: string;
		actor: string;
		actor_email: string;
		reason: string | null;
		period: string;
	}>
> {
	const snap = await db
		.collection("credits")
		.doc(TEST_USER_ID)
		.collection("grants")
		.get();
	return snap.docs.map((d) => {
		const data = d.data() as {
			amount: number;
			type: string;
			actor: string;
			actor_email: string;
			reason: string | null;
			period: string;
		};
		return {
			amount: data.amount,
			type: data.type,
			actor: data.actor,
			actor_email: data.actor_email,
			reason: data.reason,
			period: data.period,
		};
	});
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

/**
 * Seed the test app doc with an owner + reservation marker, so the cross-doc
 * `refundReservation` has a hold to reconcile. Overwrites the whole doc (no
 * merge) so each case starts from a known marker state.
 */
async function seedAppReservation(
	db: Firestore,
	reservation: { period: string; reserved: number; settled: boolean },
): Promise<void> {
	await db
		.collection("apps")
		.doc(TEST_APP_ID)
		.set({ owner: TEST_USER_ID, reservation }, { merge: false });
}

/** Read the reservation marker back off the test app doc. */
async function readAppReservation(
	db: Firestore,
): Promise<{ period: string; reserved: number; settled: boolean } | undefined> {
	const snap = await db.collection("apps").doc(TEST_APP_ID).get();
	if (!snap.exists) return undefined;
	return (
		snap.data() as {
			reservation?: { period: string; reserved: number; settled: boolean };
		}
	).reservation;
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
		await db.terminate();
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearCreditMonths(db);
		// Clear the app doc too — `reserveCredits` reads it for the leftover
		// marker, so a marker leaked from a prior case would refund into the next.
		await db.collection("apps").doc(TEST_APP_ID).delete();
	});

	it("creates the month doc with a full allowance and the booked cost on a first reservation", async () => {
		const { reserveCredits } = await import("../credits");

		const result = await reserveCredits(
			TEST_USER_ID,
			CREDITS_PER_BUILD,
			TEST_APP_ID,
			"run-1",
		);
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

	it("a second reservation refunds the first's stranded unsettled hold before booking its own", async () => {
		const { OutOfCreditsError, reserveCredits } = await import("../credits");

		// Two reservations in sequence on ONE app with no settle between. Under
		// at-most-one-run-holds this only happens when the first run died/was
		// superseded and left its hold stranded (unsettled), so the SECOND reserve
		// refunds that leftover UNCONDITIONALLY before booking its own — net consumed
		// stays at ONE build's cost, not two. (The old pre-C3 behavior double-booked;
		// the fix nets the stranded hold into the fresh debit.)
		await reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD, TEST_APP_ID, "run-a");
		await reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD, TEST_APP_ID, "run-b");
		expect((await readCreditMonth(db, period))?.consumed).toBe(
			CREDITS_PER_BUILD,
		);

		// Now seed the user to the brink: 5 spendable, charging 100 must reject.
		// (Clear the app marker first so this reserve books cleanly against the
		// seeded balance rather than netting the leftover it would otherwise refund.)
		await db.collection("apps").doc(TEST_APP_ID).delete();
		await seedCreditMonth(db, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
		await expect(
			reserveCredits(TEST_USER_ID, CREDITS_PER_BUILD, TEST_APP_ID, "run-c"),
		).rejects.toBeInstanceOf(OutOfCreditsError);

		// The rejected reservation booked nothing — the doc is exactly as seeded.
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
	});
});

/**
 * Integration round-trips for the refund and admin reset/grant writers, plus the
 * summary read. What these prove that the unit suite (scripted spies) can't:
 *
 *   - reset and grant land BOTH documents — the month-doc mutation AND the
 *     append-only audit row — in ONE committed transaction: the two `tx.set`
 *     calls share a single `runTransaction` closure, so reading both back after
 *     a successful commit proves they were written together as one unit. (This
 *     is the committed-together property, not a both-or-neither rollback claim —
 *     no failure is injected mid-transaction here.) The unit suite only proves
 *     both `tx.set` calls FIRE; it can't observe a real commit.
 *   - `resetCredits` and `grantCredits` on a user with NO current-period doc
 *     write a doc the REAL Zod converter reads back without throwing — the
 *     central hazard guard. A reset seeds a COMPLETE doc (explicit allowance,
 *     consumed 0); a grant omits `consumed` (it must never erase usage), so its
 *     doc-less write relies on `creditMonthDocSchema.consumed`'s `.default(0)` to
 *     fill the gap on read. `allowance` has no Zod default on either path, so
 *     only a real converter read over a real on-disk doc proves the seed parses.
 *     A spied read can't.
 *   - `refundReservation` decrements `consumed` on disk AND settles the app-doc
 *     marker in one cross-doc transaction, and a second pass over a settled
 *     marker is a no-op — the idempotency the live-flush/reaper collision needs.
 *
 * The production `getDb()` inside the writers/summary connects to the same
 * emulator as our `db` client via `FIRESTORE_EMULATOR_HOST`.
 */
describe.skipIf(!emulatorAvailable)("credit writers integration", () => {
	let db: Firestore;
	const period = getCurrentPeriod();
	const WHO = {
		actor: "admin-integration",
		actorEmail: "admin@dimagi.com",
		reason: "integration comp",
	};

	beforeAll(() => {
		// The reserve describe above may already have initialized the default app
		// in this worker; `initializeApp` throws on a second default-app init, so
		// only initialize when none exists yet.
		if (getApps().length === 0) {
			initializeApp({ projectId: TEST_PROJECT_ID });
		}
		db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
	});

	afterAll(async () => {
		await db.terminate();
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearCreditMonths(db);
		await clearCreditGrants(db);
	});

	it("resets a user with no current-period doc into a COMPLETE doc the converter parses", async () => {
		const { getCreditSummary, resetCredits } = await import("../credits");

		// The user has never been debited this period — no doc exists.
		expect(await readCreditMonth(db, period)).toBeUndefined();

		await resetCredits(TEST_USER_ID, WHO);

		// A complete doc landed: allowance is present (the no-default field), bonus
		// 0, consumed 0. A partial `{ consumed: 0 }` merge would have omitted
		// allowance and tripped the converter on the next read.
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
		});

		// The central hazard guard: the summary reads through the REAL Zod
		// converter. If the seed were partial (no allowance), this would THROW on
		// parse. It must instead return a clean full balance.
		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary).toMatchObject({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			balance: MONTHLY_CREDIT_ALLOWANCE,
		});

		// The reset committed its audit row in the same transaction.
		const grants = await readCreditGrants(db);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({
			type: "reset",
			amount: 0,
			actor: WHO.actor,
			actor_email: WHO.actorEmail,
			reason: WHO.reason,
			period,
		});
	});

	it("resets an existing mid-period doc to consumed 0 and appends the audit row atomically", async () => {
		const { resetCredits } = await import("../credits");

		// A mid-period doc with usage and a prior bonus.
		await seedCreditMonth(db, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 1500,
			bonus: 200,
		});

		await resetCredits(TEST_USER_ID, WHO);

		// consumed zeroed; the prior bonus and allowance preserved.
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 200,
		});
		// Both the month mutation and the audit row are on disk → committed together.
		expect(await readCreditGrants(db)).toHaveLength(1);
	});

	it("grants bonus credits and appends the audit row without touching consumed", async () => {
		const { getCreditSummary, grantCredits } = await import("../credits");

		// A mid-period doc with usage the grant must NOT disturb.
		await seedCreditMonth(db, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 300,
			bonus: 0,
		});

		await grantCredits(TEST_USER_ID, 500, WHO);

		// bonus advanced by the granted amount; consumed preserved exactly (a grant
		// is additive — it must never erase usage the way a reset does).
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 300,
			bonus: 500,
		});

		// Balance reflects the grant on top of the preserved consumed:
		// 2000 + 500 − 300 = 2200.
		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary.balance).toBe(MONTHLY_CREDIT_ALLOWANCE + 500 - 300);

		const grants = await readCreditGrants(db);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "grant", amount: 500 });
	});

	it("grants to a user with no current-period doc into a doc the converter parses (no explicit consumed)", async () => {
		const { getCreditSummary, grantCredits } = await import("../credits");

		// The user has never been debited this period — no doc exists.
		expect(await readCreditMonth(db, period)).toBeUndefined();

		const GRANT = 500;
		await grantCredits(TEST_USER_ID, GRANT, WHO);

		// The on-disk doc carries the seeded allowance, the granted bonus, and a
		// consumed of 0 that the grant NEVER wrote explicitly — it lands only
		// because `creditMonthDocSchema.consumed` carries `.default(0)`. A grant
		// must not write consumed (that would erase usage), so a future removal of
		// that default would leave the doc-less grant doc with no consumed at all.
		expect(await readCreditMonth(db, period)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: GRANT,
		});

		// The central hazard guard for the GRANT path: the summary reads through
		// the REAL Zod converter. The grant wrote no consumed; if that field's
		// `.default(0)` were ever dropped, the converter would throw on this read.
		// It must instead parse cleanly and report the granted balance on top of a
		// fresh full allowance with zero consumed.
		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary).toMatchObject({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: GRANT,
			balance: MONTHLY_CREDIT_ALLOWANCE + GRANT,
		});

		// The grant committed its audit row in the same transaction.
		const grants = await readCreditGrants(db);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "grant", amount: GRANT });
	});

	it("refunds the hold and settles the marker atomically, and is idempotent on a second pass", async () => {
		const { refundReservation } = await import("../credits");

		// A doc that booked two builds, plus an app carrying an unsettled
		// 100-credit hold owned by the test user.
		await seedCreditMonth(db, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 2 * CREDITS_PER_BUILD,
			bonus: 0,
		});
		await seedAppReservation(db, {
			period,
			reserved: CREDITS_PER_BUILD,
			settled: false,
		});

		// The refund walks consumed 200 → 100 AND flips the marker settled, both
		// committed in one cross-doc transaction.
		await refundReservation(TEST_APP_ID, "run-1");
		expect((await readCreditMonth(db, period))?.consumed).toBe(
			CREDITS_PER_BUILD,
		);
		expect(await readAppReservation(db)).toEqual({
			period,
			reserved: CREDITS_PER_BUILD,
			settled: true,
		});

		// A second refund reads the settled marker and changes nothing — the
		// once-guard the live-flush/reaper collision relies on.
		await refundReservation(TEST_APP_ID, "run-1");
		expect((await readCreditMonth(db, period))?.consumed).toBe(
			CREDITS_PER_BUILD,
		);
	});
});
