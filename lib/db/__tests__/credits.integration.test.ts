/**
 * Integration tests for the credit ledger's transactional reservation against a
 * real Postgres (the per-test-database harness). The unit-flavored suite
 * (`credits.test.ts`) drives the debit against a seeded row; this file exercises
 * the genuine `SELECT … FOR UPDATE` round-trip through `reserveForNewBuild` and
 * the admin writers, proving the read-check-write commits and reads back as a
 * complete, correctly-defaulted `credit_months` / `credit_grants` row.
 *
 * `reserveForNewBuild` is the build-reservation entry point (the credit debit
 * `claimAndReserveRun` shares via `debitAndBookReservation`); the apps here are
 * seeded `complete` so the build-concurrency scan finds no OTHER live build and
 * the case exercises the debit in isolation.
 *
 * Multi-writer contention needs no separate emulator carve-out here: two
 * reservations on one app serialize behind the app row's `FOR UPDATE` lock, so
 * the second re-reads the depleted balance and rejects — the same
 * read-then-reject the deterministic affordability case below pins.
 *
 * Runs unconditionally under `npm test`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	CREDITS_PER_BUILD,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { setupAppStateTestDb } from "./appStateTestDb";

const TEST_USER_ID = "user-credit-integration";
const TEST_APP_ID = "app-credit-integration";

const h = setupAppStateTestDb("credits_int_");
const period = getCurrentPeriod();

/** Read the raw credit-month row for the test user's current period. */
async function readCreditMonth(): Promise<
	{ allowance: number; consumed: number; bonus: number } | undefined
> {
	const row = await h
		.db()
		.selectFrom("credit_months")
		.select(["allowance", "consumed", "bonus"])
		.where("user_id", "=", TEST_USER_ID)
		.where("period", "=", period)
		.executeTakeFirst();
	return row ?? undefined;
}

/** Read back every grant audit row for the test user. */
async function readCreditGrants(): Promise<
	Array<{
		amount: number;
		type: string;
		actor: string;
		actor_email: string;
		reason: string | null;
		period: string;
	}>
> {
	return await h
		.db()
		.selectFrom("credit_grants")
		.select(["amount", "type", "actor", "actor_email", "reason", "period"])
		.where("user_id", "=", TEST_USER_ID)
		.execute();
}

/** Clear the reservation marker columns on an app row (so a later reserve books
 *  cleanly against the seeded balance rather than netting a leftover refund). */
async function clearAppMarker(appId: string): Promise<void> {
	await h
		.db()
		.updateTable("apps")
		.set({
			res_period: null,
			res_reserved: null,
			res_settled: null,
			res_user_id: null,
			res_run_id: null,
		})
		.where("id", "=", appId)
		.execute();
}

describe("reserveForNewBuild credit debit", () => {
	beforeEach(async () => {
		await h.seedApp({
			id: TEST_APP_ID,
			owner: TEST_USER_ID,
			status: "complete",
		});
	});

	it("creates the month row with a full allowance and the booked cost on a first reservation", async () => {
		const { reserveForNewBuild } = await import("../apps");

		const result = await reserveForNewBuild(
			TEST_APP_ID,
			TEST_USER_ID,
			CREDITS_PER_BUILD,
			"run-1",
		);
		expect(result).toEqual({ period, reserved: CREDITS_PER_BUILD });

		// A complete row must land — explicit allowance, zero bonus, and consumed =
		// the cost just booked.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
	});

	it("a second reservation refunds the first's stranded unsettled hold before booking its own", async () => {
		const { OutOfCreditsError } = await import("../credits");
		const { reserveForNewBuild } = await import("../apps");

		// Two reservations in sequence on ONE app with no settle between — under
		// at-most-one-run this is a superseded run's stranded hold, so the SECOND
		// reserve refunds that leftover UNCONDITIONALLY before booking its own — net
		// consumed stays at ONE build's cost, not two.
		await reserveForNewBuild(
			TEST_APP_ID,
			TEST_USER_ID,
			CREDITS_PER_BUILD,
			"run-a",
		);
		await reserveForNewBuild(
			TEST_APP_ID,
			TEST_USER_ID,
			CREDITS_PER_BUILD,
			"run-b",
		);
		expect((await readCreditMonth())?.consumed).toBe(CREDITS_PER_BUILD);

		// Now seed the user to the brink: 5 spendable, charging 100 must reject.
		// (Clear the app marker first so this reserve books cleanly against the
		// seeded balance rather than netting the leftover it would otherwise refund.)
		await clearAppMarker(TEST_APP_ID);
		await h.seedCreditMonth(TEST_USER_ID, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
		await expect(
			reserveForNewBuild(TEST_APP_ID, TEST_USER_ID, CREDITS_PER_BUILD, "run-c"),
		).rejects.toBeInstanceOf(OutOfCreditsError);

		// The rejected reservation booked nothing — the row is exactly as seeded.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: MONTHLY_CREDIT_ALLOWANCE - 5,
			bonus: 0,
		});
	});
});

/**
 * Integration round-trips for the refund and admin reset/grant writers, plus the
 * summary read. What these prove that a seeded-row unit test can't:
 *
 *   - reset and grant land BOTH rows — the `credit_months` mutation AND the
 *     append-only `credit_grants` audit row — in ONE committed transaction.
 *   - `resetCredits` / `grantCredits` on a user with NO current-period row seed a
 *     COMPLETE row (explicit allowance; grant preserves consumed) — read back and
 *     summed by `getCreditSummary` without a pre-seeding write.
 *   - `refundReservation` decrements `consumed` AND settles the app-row marker in
 *     one cross-row transaction, and a second pass over a settled marker is a
 *     no-op — the idempotency the live-flush/reaper collision needs.
 */
describe("credit writers integration", () => {
	const WHO = {
		actor: "admin-integration",
		actorEmail: "admin@dimagi.com",
		reason: "integration comp",
	};

	it("resets a user with no current-period row into a COMPLETE row the summary reads", async () => {
		const { getCreditSummary, resetCredits } = await import("../credits");

		expect(await readCreditMonth()).toBeUndefined();

		await resetCredits(TEST_USER_ID, WHO);

		// A complete row landed: allowance present, bonus 0, consumed 0.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
		});

		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary).toMatchObject({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			balance: MONTHLY_CREDIT_ALLOWANCE,
		});

		// The reset committed its audit row in the same transaction.
		const grants = await readCreditGrants();
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

	it("resets an existing mid-period row to consumed 0 and appends the audit row atomically", async () => {
		const { resetCredits } = await import("../credits");

		await h.seedCreditMonth(TEST_USER_ID, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 1500,
			bonus: 200,
		});

		await resetCredits(TEST_USER_ID, WHO);

		// consumed zeroed; the prior bonus and allowance preserved.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 200,
		});
		expect(await readCreditGrants()).toHaveLength(1);
	});

	it("grants bonus credits and appends the audit row without touching consumed", async () => {
		const { getCreditSummary, grantCredits } = await import("../credits");

		await h.seedCreditMonth(TEST_USER_ID, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 300,
			bonus: 0,
		});

		await grantCredits(TEST_USER_ID, 500, WHO);

		// bonus advanced by the granted amount; consumed preserved exactly.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 300,
			bonus: 500,
		});

		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary.balance).toBe(MONTHLY_CREDIT_ALLOWANCE + 500 - 300);

		const grants = await readCreditGrants();
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "grant", amount: 500 });
	});

	it("grants to a user with no current-period row into a complete row (consumed defaults to 0)", async () => {
		const { getCreditSummary, grantCredits } = await import("../credits");

		expect(await readCreditMonth()).toBeUndefined();

		const GRANT = 500;
		await grantCredits(TEST_USER_ID, GRANT, WHO);

		// The row carries the seeded allowance, the granted bonus, and consumed 0 —
		// a grant never disturbs usage.
		expect(await readCreditMonth()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: GRANT,
		});

		const summary = await getCreditSummary(TEST_USER_ID);
		expect(summary).toMatchObject({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: GRANT,
			balance: MONTHLY_CREDIT_ALLOWANCE + GRANT,
		});

		const grants = await readCreditGrants();
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "grant", amount: GRANT });
	});

	it("refunds the hold and settles the marker atomically, and is idempotent on a second pass", async () => {
		const { refundReservation } = await import("../credits");

		// A row that booked two builds, plus an app carrying an unsettled 100-credit
		// hold owned by the test user (a `complete` app → marker owned by "none",
		// so the terminal-write gate passes).
		await h.seedCreditMonth(TEST_USER_ID, period, {
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 2 * CREDITS_PER_BUILD,
			bonus: 0,
		});
		await h.seedApp({
			id: TEST_APP_ID,
			owner: TEST_USER_ID,
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: TEST_USER_ID,
			},
		});

		// The refund walks consumed 200 → 100 AND flips the marker settled, both
		// committed in one cross-row transaction.
		await refundReservation(TEST_APP_ID, "run-1");
		expect((await readCreditMonth())?.consumed).toBe(CREDITS_PER_BUILD);
		expect(await h.readReservation(TEST_APP_ID)).toMatchObject({
			period,
			reserved: CREDITS_PER_BUILD,
			settled: true,
		});

		// A second refund reads the settled marker and changes nothing.
		await refundReservation(TEST_APP_ID, "run-1");
		expect((await readCreditMonth())?.consumed).toBe(CREDITS_PER_BUILD);
	});
});
