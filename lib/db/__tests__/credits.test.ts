/**
 * Credit-ledger logic tests.
 *
 * Two layers:
 *  - The PURE credit-policy helpers + constants (`creditPolicy.ts`) — no DB,
 *    pinned exactly (`creditBalance` / `chargeAmount` / `isChargeableTurn` and
 *    the five exported amounts).
 *  - The reservation debit + refund + admin reset/grant + summary/balance reads
 *    (`credits.ts` / `apps.ts`), driven against the per-test Postgres harness so
 *    each branch (missing-row seed, affordability boundary, over-budget reject,
 *    consumed clamp, settle idempotency, lifetime sum) is exercised over a real
 *    `SELECT … FOR UPDATE` round-trip rather than a scripted stand-in.
 *
 * The credit-ledger invariants are column types + CHECK constraints (`integer`,
 * `>= 0`, the `type IN ('reset','grant')` enum) enforced by the database, not a
 * Zod parse in application code.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	COST_BACKSTOP_USD,
	CREDITS_PER_BUILD,
	CREDITS_PER_DOLLAR,
	CREDITS_PER_EDIT,
	chargeAmount,
	creditBalance,
	isChargeableTurn,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("credits_unit_");
const period = getCurrentPeriod();
const PROJECT_ID = "project-test";

/**
 * Build a minimal `UIMessage` of a given role for the `isChargeableTurn` cases —
 * the helper reads only the last message's role.
 */
const u = (role: "user" | "assistant"): UIMessage =>
	({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

/** Read the raw credit-month row for a user's current period. */
async function readMonth(
	userId: string,
): Promise<{ allowance: number; consumed: number; bonus: number } | undefined> {
	const row = await h
		.db()
		.selectFrom("credit_months")
		.select(["allowance", "consumed", "bonus"])
		.where("user_id", "=", userId)
		.where("period", "=", period)
		.executeTakeFirst();
	return row ?? undefined;
}

async function readGrants(
	userId: string,
): Promise<Array<{ amount: number; type: string; reason: string | null }>> {
	return await h
		.db()
		.selectFrom("credit_grants")
		.select(["amount", "type", "reason"])
		.where("user_id", "=", userId)
		.execute();
}

/**
 * Pure credit-policy tests — the constants and the three pure helpers
 * (`creditBalance`, `chargeAmount`, `isChargeableTurn`) that `creditPolicy.ts`
 * exports. Client-safety (no server data-layer import) is a static property of
 * the module's `import type`-only lines, not something a Node test can observe.
 */
describe("credit policy — pure helpers and constants", () => {
	it("locks the five exported credit amounts to their decided values", () => {
		expect([
			CREDITS_PER_DOLLAR,
			CREDITS_PER_BUILD,
			CREDITS_PER_EDIT,
			MONTHLY_CREDIT_ALLOWANCE,
			COST_BACKSTOP_USD,
		]).toEqual([100, 100, 5, 2000, 300]);
	});

	it("computes balance as allowance + bonus − consumed", () => {
		expect(creditBalance({ allowance: 2000, consumed: 105, bonus: 0 })).toBe(
			1895,
		);
		expect(creditBalance({ allowance: 2000, consumed: 105, bonus: 500 })).toBe(
			2395,
		);
	});

	it("reads an absent credit doc as a full monthly allowance", () => {
		expect(creditBalance(undefined)).toBe(MONTHLY_CREDIT_ALLOWANCE);
	});

	it("charges the build amount when no app exists yet", () => {
		expect(chargeAmount(false)).toBe(CREDITS_PER_BUILD);
		expect(chargeAmount(false)).toBe(100);
	});

	it("charges the cheap edit amount once an app exists", () => {
		expect(chargeAmount(true)).toBe(CREDITS_PER_EDIT);
		expect(chargeAmount(true)).toBe(5);
	});

	it("charges a turn whose last RAW message is from the user", () => {
		expect(isChargeableTurn([u("assistant"), u("user")])).toBe(true);
	});

	it("treats a turn ending in an assistant message as a free continuation", () => {
		expect(isChargeableTurn([u("user"), u("assistant")])).toBe(false);
	});

	it("treats an empty message list as non-chargeable", () => {
		expect(isChargeableTurn([])).toBe(false);
	});
});

/**
 * The reservation debit — `reserveForNewBuild` (the build-reservation entry point
 * `claimAndReserveRun` shares via `debitAndBookReservation`) over the per-test
 * DB. Apps are seeded `complete` so the build-concurrency scan finds no OTHER
 * live build and each case exercises the read-check-write in isolation.
 */
describe("reserveForNewBuild debit", () => {
	const USER = "user-reserve-test";
	const APP = "app-reserve-test";

	it("seeds a full allowance, books the cost, and records the marker on a missing row", async () => {
		await h.seedApp({ id: APP, owner: USER, status: "complete" });
		const { reserveForNewBuild } = await import("../apps");

		const result = await reserveForNewBuild(
			APP,
			USER,
			CREDITS_PER_BUILD,
			"run-1",
			PROJECT_ID,
		);

		expect(await readMonth(USER)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			bonus: 0,
			consumed: CREDITS_PER_BUILD,
		});
		// The marker is co-written in the same transaction, recording the CHARGED
		// actor (refunds target it, not `owner`) and the booking run.
		expect(await h.readReservation(APP)).toMatchObject({
			period,
			reserved: CREDITS_PER_BUILD,
			settled: false,
			userId: USER,
			runId: "run-1",
		});
		expect(result).toEqual({ period, reserved: CREDITS_PER_BUILD });
	});

	it("increments consumed on an existing affordable row, preserving allowance and bonus", async () => {
		await h.seedApp({ id: APP, owner: USER, status: "complete" });
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 50,
			bonus: 300,
		});
		const { reserveForNewBuild } = await import("../apps");

		await reserveForNewBuild(APP, USER, CREDITS_PER_BUILD, "run-1", PROJECT_ID);

		expect(await readMonth(USER)).toEqual({
			allowance: 2000,
			bonus: 300,
			consumed: 50 + CREDITS_PER_BUILD,
		});
	});

	it("books a cost exactly equal to the remaining balance (the boundary is affordable)", async () => {
		await h.seedApp({ id: APP, owner: USER, status: "complete" });
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 1900,
			bonus: 0,
		});
		const { reserveForNewBuild } = await import("../apps");

		await reserveForNewBuild(APP, USER, CREDITS_PER_BUILD, "run-1", PROJECT_ID);
		expect((await readMonth(USER))?.consumed).toBe(2000);
	});

	it("throws OutOfCreditsError and never writes when the balance can't cover the cost", async () => {
		await h.seedApp({ id: APP, owner: USER, status: "complete" });
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 1995,
			bonus: 0,
		});
		const { OutOfCreditsError } = await import("../credits");
		const { reserveForNewBuild } = await import("../apps");

		await expect(
			reserveForNewBuild(APP, USER, CREDITS_PER_BUILD, "run-1", PROJECT_ID),
		).rejects.toBeInstanceOf(OutOfCreditsError);
		// The rejected reservation booked nothing — the row is exactly as seeded.
		expect(await readMonth(USER)).toEqual({
			allowance: 2000,
			consumed: 1995,
			bonus: 0,
		});
		expect(await h.readReservation(APP)).toBeUndefined();
	});

	it("carries the human-readable message and name on OutOfCreditsError", async () => {
		const { OutOfCreditsError } = await import("../credits");
		const err = new OutOfCreditsError();
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("OutOfCreditsError");
		expect(err.message).toBe("Out of credits for this period");
	});

	it("a later reservation re-reads the depleted balance and rejects (row-lock serialized)", async () => {
		// The read-check-write path on a balance a prior reserve depleted: seed the
		// user with exactly one build's headroom, book the first (different app, so
		// no leftover nets it out), then a second reserve re-reads consumed at the
		// full allowance and rejects — the deterministic stand-in for what a loser
		// undergoes when the credit-month row lock serializes two contenders.
		await h.seedApp({ id: "app-1", owner: USER, status: "complete" });
		await h.seedApp({ id: "app-2", owner: USER, status: "complete" });
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 1900,
			bonus: 0,
		});
		const { OutOfCreditsError } = await import("../credits");
		const { reserveForNewBuild } = await import("../apps");

		await reserveForNewBuild(
			"app-1",
			USER,
			CREDITS_PER_BUILD,
			"run-1",
			PROJECT_ID,
		);
		expect((await readMonth(USER))?.consumed).toBe(2000);

		await expect(
			reserveForNewBuild("app-2", USER, CREDITS_PER_BUILD, "run-2", PROJECT_ID),
		).rejects.toBeInstanceOf(OutOfCreditsError);
		expect((await readMonth(USER))?.consumed).toBe(2000);
	});
});

/**
 * `refundReservation` over the per-test DB — the failure-flush refund walks
 * `consumed` down AND settles the app-row marker in one cross-row transaction,
 * clamps at zero, and no-ops on a settled / absent marker (the idempotency the
 * live-flush/reaper collision needs). Apps are seeded `complete` so the marker
 * is owned by mode `"none"` and the terminal-write gate passes.
 */
describe("refundReservation", () => {
	const APP = "app-refund-test";
	const OWNER = "user-refund-test";

	it("un-books the reserved amount and settles the marker in one cross-row transaction", async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: 250,
			bonus: 0,
		});
		await h.seedApp({
			id: APP,
			owner: OWNER,
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP, "run-1");

		expect((await readMonth(OWNER))?.consumed).toBe(250 - CREDITS_PER_BUILD);
		expect(await h.readReservation(APP)).toMatchObject({ settled: true });
	});

	it("clamps consumed at zero rather than booking a negative balance", async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: 40,
			bonus: 0,
		});
		await h.seedApp({
			id: APP,
			owner: OWNER,
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP, "run-1");
		expect((await readMonth(OWNER))?.consumed).toBe(0);
	});

	it("is idempotent — an already-settled marker refunds nothing and writes nothing", async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
		await h.seedApp({
			id: APP,
			owner: OWNER,
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: true,
				userId: OWNER,
			},
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP, "run-1");
		expect((await readMonth(OWNER))?.consumed).toBe(CREDITS_PER_BUILD);
	});

	it("no-ops on an app with no reservation marker (a free turn / pre-reservation app)", async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: 300,
			bonus: 0,
		});
		await h.seedApp({ id: APP, owner: OWNER, status: "complete" });
		const { refundReservation } = await import("../credits");

		await refundReservation(APP, "run-1");
		expect((await readMonth(OWNER))?.consumed).toBe(300);
	});

	it("settles the marker even when the debited month row is gone (nothing to un-book)", async () => {
		// A never-debited (or already-reset) month has no credit row — nothing to
		// un-book, but the marker is still settled so the reaper stops revisiting it.
		await h.seedApp({
			id: APP,
			owner: OWNER,
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP, "run-1");
		expect(await readMonth(OWNER)).toBeUndefined();
		expect(await h.readReservation(APP)).toMatchObject({ settled: true });
	});
});

describe("resetCredits", () => {
	const USER = "user-reset-test";
	const WHO = {
		actor: "admin-1",
		actorEmail: "admin@dimagi.com",
		reason: "support comp",
	};

	it("zeroes consumed on an existing row, preserves allowance/bonus, and appends a reset audit row", async () => {
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 1500,
			bonus: 200,
		});
		const { resetCredits } = await import("../credits");

		await resetCredits(USER, WHO);

		expect(await readMonth(USER)).toEqual({
			allowance: 2000,
			consumed: 0,
			bonus: 200,
		});
		const grants = await readGrants(USER);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "reset", amount: 0 });
	});

	it("seeds the full allowance when resetting a user with no current-period row", async () => {
		const { resetCredits } = await import("../credits");

		await resetCredits(USER, {
			actor: "admin-1",
			actorEmail: "admin@dimagi.com",
			reason: null,
		});

		expect(await readMonth(USER)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
		});
		expect(await readGrants(USER)).toEqual([
			{ type: "reset", amount: 0, reason: null },
		]);
	});
});

describe("grantCredits", () => {
	const USER = "user-grant-test";
	const WHO = {
		actor: "admin-1",
		actorEmail: "admin@dimagi.com",
		reason: "beta tester comp",
	};

	it("adds to bonus without touching consumed and appends a grant audit row", async () => {
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 300,
			bonus: 100,
		});
		const { grantCredits } = await import("../credits");

		await grantCredits(USER, 500, WHO);

		// bonus advanced; consumed preserved exactly (a grant never erases usage).
		expect(await readMonth(USER)).toEqual({
			allowance: 2000,
			consumed: 300,
			bonus: 100 + 500,
		});
		const grants = await readGrants(USER);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ type: "grant", amount: 500 });
	});

	it("seeds the full allowance when granting to a user with no current-period row", async () => {
		const { grantCredits } = await import("../credits");

		await grantCredits(USER, 250, WHO);

		expect(await readMonth(USER)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 250,
		});
		expect(await readGrants(USER)).toEqual([
			{ type: "grant", amount: 250, reason: WHO.reason },
		]);
	});
});

/**
 * `getCreditSummary` over a seeded month set — the current period's balance plus
 * lifetime consumed summed across EVERY month row.
 */
describe("getCreditSummary", () => {
	const USER = "user-summary-test";

	it("reports the current period's balance and sums lifetime consumed across all months", async () => {
		await h.seedCreditMonth(USER, "2026-04", {
			allowance: 2000,
			consumed: 600,
			bonus: 0,
		});
		await h.seedCreditMonth(USER, "2026-05", {
			allowance: 2000,
			consumed: 2000,
			bonus: 0,
		});
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 105,
			bonus: 50,
		});
		const { getCreditSummary } = await import("../credits");

		expect(await getCreditSummary(USER)).toEqual({
			period,
			allowance: 2000,
			consumed: 105,
			bonus: 50,
			balance: 1945,
			lifetimeConsumed: 2705,
		});
	});

	it("reads the current period as a full balance when its row is absent yet still sums prior months", async () => {
		await h.seedCreditMonth(USER, "2026-04", {
			allowance: 2000,
			consumed: 300,
			bonus: 0,
		});
		await h.seedCreditMonth(USER, "2026-05", {
			allowance: 2000,
			consumed: 450,
			bonus: 0,
		});
		const { getCreditSummary } = await import("../credits");

		expect(await getCreditSummary(USER)).toEqual({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			balance: MONTHLY_CREDIT_ALLOWANCE,
			lifetimeConsumed: 750,
		});
	});

	it("reports a full balance and zero lifetime for a user with no months at all", async () => {
		const { getCreditSummary } = await import("../credits");

		expect(await getCreditSummary(USER)).toEqual({
			period: getCurrentPeriod(),
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			balance: MONTHLY_CREDIT_ALLOWANCE,
			lifetimeConsumed: 0,
		});
	});
});

/**
 * `getCurrentCreditBalance` — the chat gate's hot-path read of ONE row: a present
 * row yields `allowance + bonus − consumed`; an absent row yields a full
 * allowance (no pre-seeding write).
 */
describe("getCurrentCreditBalance", () => {
	const USER = "user-balance-test";

	it("returns allowance + bonus − consumed for the present current-period row", async () => {
		await h.seedCreditMonth(USER, period, {
			allowance: 2000,
			consumed: 105,
			bonus: 50,
		});
		const { getCurrentCreditBalance } = await import("../credits");
		expect(await getCurrentCreditBalance(USER)).toBe(1945);
	});

	it("returns a full allowance when the current-period row is absent (no pre-seeding write)", async () => {
		const { getCurrentCreditBalance } = await import("../credits");
		expect(await getCurrentCreditBalance(USER)).toBe(MONTHLY_CREDIT_ALLOWANCE);
	});
});
