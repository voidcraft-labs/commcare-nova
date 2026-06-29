/**
 * Credit-ledger schema tests.
 *
 * These cover the two Firestore document shapes the credit gate stores:
 * `CreditMonthDoc` (the resettable per-period balance) and `CreditGrantDoc`
 * (the append-only admin audit row). They are pure `schema.parse` tests — no
 * Firestore, no transactions — so they assert exactly the schema contract:
 * which fields default, which are required, and which value ranges reject.
 *
 * Both schemas carry a required `z.instanceof(Timestamp)` field (`updated_at` /
 * `created_at`), matching every other timestamped doc in `lib/db/types.ts`
 * (`usageDocSchema`, `appDocSchema`). On a real read Firestore always returns a
 * `Timestamp` instance, so every parse input here supplies one via
 * `Timestamp.fromDate(...)` — the same fixture pattern `listApps`/
 * `oauth-consents`/`api-keys` tests use. Stubbing it on EVERY parse call is
 * load-bearing for test honesty: the timestamp field is required, so a missing
 * timestamp makes `.parse` throw on its own. A stub-less rejection case would
 * therefore stay green even with the field guard under test removed — it would
 * still throw, just on the missing timestamp. Supplying the stub is what lets
 * removing a `.int()`/`.nonnegative()` guard flip the parse to success and turn
 * the test red — without it the test would pass for the wrong reason.
 */
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTUAL_COST_BACKSTOP_USD,
	CREDITS_PER_BUILD,
	CREDITS_PER_DOLLAR,
	CREDITS_PER_EDIT,
	chargeAmount,
	creditBalance,
	isChargeableTurn,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { creditGrantDocSchema, creditMonthDocSchema } from "@/lib/db/types";

/**
 * Hoisted transaction mock for the `reserveCredits` unit suite.
 *
 * `reserveCredits` does NOT reach the transaction the way `runSummary` does
 * (which calls `getDb().runTransaction(...)`). It resolves a raw doc ref via
 * `docs.creditMonthRaw(...)` and runs the transaction off `ref.firestore`:
 *
 *   const ref = docs.creditMonthRaw(userId, period);
 *   await ref.firestore.runTransaction(async (tx) => { ... });
 *
 * So the mock returns one fixed `ref` object whose `.firestore.runTransaction`
 * IS the hoisted `runTransactionMock`. That same `ref` is the identity the
 * production code passes to `tx.get(ref)` / `tx.set(ref, ...)`, so asserting
 * `txGet`/`txSet` were called with `ref` proves the reservation read and wrote
 * the right document — not a freshly reconstructed ref. `txGet`/`txSet` are the
 * inner `tx` spies; `runTransactionMock` drives the closure so each test scripts
 * exactly what the transactional read returns.
 *
 * `./period` is intentionally NOT mocked: the real `getCurrentPeriod` runs and
 * the test imports it to compute the expected period, so the returned
 * `Reservation.period` is checked against the genuine value rather than a stub
 * that could drift from production.
 */
const {
	txGet,
	txSet,
	runTransactionMock,
	ref,
	appRef,
	grantRef,
	creditMonthsGet,
	creditMonthGet,
} = vi.hoisted(() => {
	const runTransactionMock = vi.fn();
	// The raw month ref the production code holds: its `.firestore.runTransaction`
	// is the entry point shared by every transactional writer here (reserve,
	// refund, reset, grant), and `ref` itself is the month-doc identity asserted
	// below. reset/grant write a SECOND doc — the audit row — so a distinct
	// `grantRef` stands in for `collections.creditGrants(userId).doc()`. The two
	// `tx.set` calls reset/grant make are told apart by ref identity (month vs
	// grant), never by call order, so a future reordering of the writes can't make
	// an assertion silently pass against the wrong document.
	const ref = { firestore: { runTransaction: runTransactionMock } };
	// The raw APP ref: the reservation co-writes the marker onto it, and the
	// refund reconciliation reads/writes it. Its `firestore.runTransaction` is the
	// same hoisted mock, since `refundReservation` runs the transaction off it.
	const appRef = { firestore: { runTransaction: runTransactionMock } };
	const grantRef = { __kind: "grantRef" };
	// `getCreditSummary` is a plain collection read, NOT a transaction — it calls
	// `collections.creditMonths(userId).get()`. This spy stands in for that read so
	// each summary case scripts the on-disk month set it sums over.
	const creditMonthsGet = vi.fn();
	// `getCurrentCreditBalance` reads ONE converter-applied doc, NOT the whole
	// collection — it calls `docs.creditMonth(userId, period).get()`. This spy
	// stands in for that single-doc read so each balance case scripts just the
	// current-period snapshot, isolating the hot-path read from the summary's
	// collection scan.
	const creditMonthGet = vi.fn();
	return {
		txGet: vi.fn(),
		txSet: vi.fn(),
		runTransactionMock,
		ref,
		appRef,
		grantRef,
		creditMonthsGet,
		creditMonthGet,
	};
});

vi.mock("../firestore", () => ({
	// `docs.creditMonthRaw` resolves the converter-less month ref every
	// transactional writer reads/writes; `docs.creditMonth` is the converter-applied
	// single-doc ref the hot-path balance read goes through;
	// `collections.creditGrants(...).doc()` mints the append-only audit ref
	// reset/grant write alongside it; and `collections.creditMonths(...).get()` is
	// the summary's read of every month.
	docs: {
		creditMonthRaw: () => ref,
		creditMonth: () => ({ get: creditMonthGet }),
		appRaw: () => appRef,
	},
	collections: {
		creditGrants: () => ({ doc: () => grantRef }),
		creditMonths: () => ({ get: creditMonthsGet }),
	},
}));

/** A fixed read-shape timestamp so each parse fails (or passes) for its own field. */
const ts = Timestamp.fromDate(new Date("2026-06-03T00:00:00Z"));

/**
 * Build a minimal `UIMessage` of a given role for the `isChargeableTurn` cases.
 * Only `role` is load-bearing for the charge signal — the helper reads the last
 * message's role and nothing else — so `id`/`parts` are filler that just satisfy
 * the shape the route passes in from the raw request body.
 */
const u = (role: "user" | "assistant"): UIMessage =>
	({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

describe("creditMonthDocSchema", () => {
	it("defaults consumed and bonus to 0 when only allowance is supplied", () => {
		const parsed = creditMonthDocSchema.parse({
			allowance: 2000,
			updated_at: ts,
		});
		expect(parsed).toMatchObject({ allowance: 2000, consumed: 0, bonus: 0 });
	});

	it("requires allowance — it has no default, so an absent allowance throws", () => {
		// `allowance` is never defaulted. A default would silently re-seed a
		// partially-written doc on read and couple this
		// schema to the credit-amount module, so the reservation must always write
		// it explicitly. The Timestamp stub is supplied so parse reaches the
		// missing-`allowance` guard rather than short-circuiting on a missing
		// `updated_at` — i.e. this throws for the reason under test, and a future
		// `.default(...)` slipped onto `allowance` would turn it red.
		expect(() => creditMonthDocSchema.parse({ updated_at: ts })).toThrow();
	});

	// Every credit quantity carries `.nonnegative()` — a negative balance
	// component is corruption, never a valid state. Parametrized so all three
	// floors are covered; testing only one would let a dropped `.nonnegative()`
	// on either of the others ship green. Each row starts from a valid doc and
	// flips one quantity negative, supplying the Timestamp stub so parse reaches
	// the field guard rather than throwing first on a missing `updated_at`.
	it.each([
		"allowance",
		"consumed",
		"bonus",
	] as const)("rejects a negative %s", (quantity) => {
		expect(() =>
			creditMonthDocSchema.parse({
				allowance: 2000,
				consumed: 0,
				bonus: 0,
				[quantity]: -1,
				updated_at: ts,
			}),
		).toThrow();
	});

	// Credits are whole units (build 100, edit 5), so every quantity carries
	// `.int()`. A fractional value is corruption. Parametrized across all three
	// quantities so dropping `.int()` from any one of them turns a test red;
	// testing only `consumed` would let a dropped `.int()` on `allowance` or
	// `bonus` ship green. Each row starts from a valid doc and flips one quantity
	// fractional, supplying the Timestamp stub so parse reaches the field guard
	// rather than throwing first on a missing `updated_at`.
	it.each([
		"allowance",
		"consumed",
		"bonus",
	] as const)("rejects a fractional %s", (quantity) => {
		expect(() =>
			creditMonthDocSchema.parse({
				allowance: 2000,
				consumed: 0,
				bonus: 0,
				[quantity]: 0.5,
				updated_at: ts,
			}),
		).toThrow();
	});
});

describe("creditGrantDocSchema", () => {
	it("accepts a reset grant row", () => {
		const row = creditGrantDocSchema.parse({
			amount: 0,
			type: "reset",
			actor: "admin1",
			actor_email: "a@dimagi.com",
			reason: null,
			period: "2026-06",
			created_at: ts,
		});
		expect(row.type).toBe("reset");
	});

	it("defaults reason to null when omitted", () => {
		// `reason` is `.nullable().default(null)` — an admin acting without a
		// justification omits the key entirely, so the default (not just the
		// nullability) must materialize it as `null` for the audit display.
		const row = creditGrantDocSchema.parse({
			amount: 50,
			type: "grant",
			actor: "admin1",
			actor_email: "a@dimagi.com",
			period: "2026-06",
			created_at: ts,
		});
		expect(row.reason).toBeNull();
	});

	it("rejects an out-of-enum type", () => {
		// `type` is a closed `["reset", "grant"]` enum — only the two recorded
		// interventions are valid; anything else is corruption and must throw.
		expect(() =>
			creditGrantDocSchema.parse({
				amount: 0,
				type: "invalid",
				actor: "admin1",
				actor_email: "a@dimagi.com",
				reason: null,
				period: "2026-06",
				created_at: ts,
			}),
		).toThrow();
	});

	it("rejects a negative amount", () => {
		// `amount` carries the same `.nonnegative()` floor as the credit-month
		// quantities — a reset writes 0 and a grant a positive amount, so a
		// negative is corruption and must throw.
		expect(() =>
			creditGrantDocSchema.parse({
				amount: -1,
				type: "grant",
				actor: "admin1",
				actor_email: "a@dimagi.com",
				reason: null,
				period: "2026-06",
				created_at: ts,
			}),
		).toThrow();
	});

	it("rejects a fractional amount", () => {
		// `amount` carries the same `.int()` floor as the credit-month quantities
		// — credits are discrete whole units, so a fractional grant is corruption
		// and must throw. Pinning it here keeps `amount`'s `.int()` from being
		// silently dropped.
		expect(() =>
			creditGrantDocSchema.parse({
				amount: 0.5,
				type: "grant",
				actor: "admin1",
				actor_email: "a@dimagi.com",
				reason: null,
				period: "2026-06",
				created_at: ts,
			}),
		).toThrow();
	});
});

/**
 * Pure credit-policy tests — the constants and the three pure helpers
 * (`creditBalance`, `chargeAmount`, `isChargeableTurn`) that `lib/db/creditPolicy.ts`
 * exports. This module is the single source of truth for the credit amounts and
 * is deliberately dependency-free (type-only imports) so the same `chargeAmount`
 * runs in the server gate and in the client send-button indicator; these tests
 * pin the arithmetic those surfaces depend on.
 *
 * Note: client-safety (no runtime Firestore/server import) is a *static* property
 * of the module's import lines, not something a Node test can observe — the
 * guarantee is enforced by the `import type`-only imports in `creditPolicy.ts`,
 * not asserted here.
 */
describe("credit policy — pure helpers and constants", () => {
	it("locks the five exported credit amounts to their decided values", () => {
		// Every exported constant is pinned, not a representative subset: a silent
		// edit to any single amount (e.g. an edit re-priced to 10) must turn this
		// red. The order mirrors the declaration order in `creditPolicy.ts`.
		expect([
			CREDITS_PER_DOLLAR,
			CREDITS_PER_BUILD,
			CREDITS_PER_EDIT,
			MONTHLY_CREDIT_ALLOWANCE,
			ACTUAL_COST_BACKSTOP_USD,
		]).toEqual([100, 100, 5, 2000, 50]);
	});

	it("computes balance as allowance + bonus − consumed", () => {
		// A debited mid-period doc: 2000 allowance, 105 consumed (one build + one
		// edit), no bonus → 1895 spendable.
		expect(creditBalance({ allowance: 2000, consumed: 105, bonus: 0 })).toBe(
			1895,
		);
		// A bonus is additive on top of the allowance.
		expect(creditBalance({ allowance: 2000, consumed: 105, bonus: 500 })).toBe(
			2395,
		);
	});

	it("reads an absent credit doc as a full monthly allowance", () => {
		// The gate and the dashboard treat a never-written period as a fresh
		// 2000/2000 — no pre-seeding write is required for a correct day-one read.
		expect(creditBalance(undefined)).toBe(MONTHLY_CREDIT_ALLOWANCE);
	});

	it("charges the build amount when no app exists yet", () => {
		// appReady === false → a new-app generation → the full build unit.
		expect(chargeAmount(false)).toBe(CREDITS_PER_BUILD);
		expect(chargeAmount(false)).toBe(100);
	});

	it("charges the cheap edit amount once an app exists", () => {
		// appReady === true → an edit to an existing app → kept cheap so iterating
		// feels nearly free.
		expect(chargeAmount(true)).toBe(CREDITS_PER_EDIT);
		expect(chargeAmount(true)).toBe(5);
	});

	it("charges a turn whose last RAW message is from the user", () => {
		// A fresh user instruction always appends a `user` message — that is the
		// server-observable signal that a new generation is starting.
		expect(isChargeableTurn([u("assistant"), u("user")])).toBe(true);
	});

	it("treats a turn ending in an assistant message as a free continuation", () => {
		// An answered-askQuestions auto-resend ends with the SA's `assistant`
		// message; it belongs to the generation already charged when the user's
		// instruction kicked it off, so it must not charge again.
		expect(isChargeableTurn([u("user"), u("assistant")])).toBe(false);
	});

	it("treats an empty message list as non-chargeable", () => {
		// No last message → `undefined?.role` → never charges. Guards the
		// degenerate input rather than letting `.at(-1)` throw downstream.
		expect(isChargeableTurn([])).toBe(false);
	});
});

/**
 * `reserveCredits` LOGIC against a scripted transaction.
 *
 * These cover the read-check-write branches of the reservation: the
 * balance computation from raw transaction data (including defaults for a
 * missing doc), the over-budget rejection, and the exact merge payload the
 * write seeds. The transaction is driven by hand (`runTransactionMock`
 * invokes the closure with the `txGet`/`txSet` spies) so each branch is
 * deterministic.
 *
 * The reservation reads the balance and writes a literal incremented
 * `consumed` (not `FieldValue.increment`) precisely so the gate can reject
 * over-budget INSIDE the transaction; the literal is pinned by the numeric
 * `consumed:` assertions in the seed and increment cases below.
 */
describe("reserveCredits", () => {
	const USER = "user-reserve-test";
	const APP = "app-reserve-test";

	beforeEach(() => {
		txGet.mockReset();
		txSet.mockReset();
		runTransactionMock.mockReset();
		// Default driver: run the closure exactly once with the spy-backed tx.
		runTransactionMock.mockImplementation(
			async (
				closure: (tx: {
					get: typeof txGet;
					set: typeof txSet;
				}) => Promise<void>,
			) => {
				await closure({ get: txGet, set: txSet });
			},
		);
	});

	/**
	 * Extract the single `tx.set` payload, asserting it was called on the same
	 * `ref` the production code read from — so a future accidental
	 * ref-reconstruction (writing a different doc than was balance-checked)
	 * shows up as a failed test, not a silent wrong-doc write.
	 */
	function setPayload(): Record<string, unknown> {
		const call = txSet.mock.calls.find(([setRef]) => setRef === ref);
		expect(call).toBeDefined();
		return (call as unknown[])[1] as Record<string, unknown>;
	}

	/** The reservation MARKER payload reserve co-writes onto the app doc. */
	function markerPayload(): Record<string, unknown> {
		const call = txSet.mock.calls.find(([setRef]) => setRef === appRef);
		expect(call).toBeDefined();
		return (call as unknown[])[1] as Record<string, unknown>;
	}

	it("seeds a full allowance and books the cost on a missing doc", async () => {
		// First reservation of a never-touched period: no doc exists, so the
		// write must SEED a complete doc (explicit allowance + bonus, since
		// `allowance` has no Zod default) with consumed = the cost just booked.
		txGet.mockResolvedValue({ exists: false, data: () => undefined });
		const { reserveCredits } = await import("../credits");

		const result = await reserveCredits(USER, CREDITS_PER_BUILD, APP);

		expect(setPayload()).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			bonus: 0,
			consumed: CREDITS_PER_BUILD,
			updated_at: FieldValue.serverTimestamp(),
		});
		// The marker is co-written onto the app doc in the same transaction, so a
		// committed charge always carries the record the reaper refunds against.
		expect(markerPayload()).toEqual({
			reservation: {
				period: getCurrentPeriod(),
				reserved: CREDITS_PER_BUILD,
				settled: false,
				// The charged actor is recorded so a refund returns the hold to
				// the user who ran it, not `app.owner`.
				userId: USER,
			},
		});
		// The booked period is the genuine current period; reserved echoes cost.
		expect(result).toEqual({
			period: getCurrentPeriod(),
			reserved: CREDITS_PER_BUILD,
		});
	});

	it("increments consumed on an existing affordable doc, preserving allowance and bonus", async () => {
		// A mid-period doc with plenty of headroom (2000 + 300 bonus − 50
		// consumed = 2250 spendable) easily covers a 100-credit build. The
		// write must preserve the prior allowance/bonus and only advance
		// consumed by the cost — re-seeding allowance/bonus from the read so a
		// merge can never strand a partially-written doc.
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 50, bonus: 300 }),
		});
		const { reserveCredits } = await import("../credits");

		const result = await reserveCredits(USER, CREDITS_PER_BUILD, APP);

		expect(setPayload()).toEqual({
			allowance: 2000,
			bonus: 300,
			consumed: 50 + CREDITS_PER_BUILD,
			updated_at: FieldValue.serverTimestamp(),
		});
		expect(txSet.mock.calls[0][2]).toEqual({ merge: true });
		expect(result).toEqual({
			period: getCurrentPeriod(),
			reserved: CREDITS_PER_BUILD,
		});
	});

	it("books a cost exactly equal to the remaining balance (the boundary is affordable)", async () => {
		// Balance exactly equals the cost: allowance 2000, consumed 1900, no
		// bonus → 100 spendable, charging 100. The check is `balance < cost`,
		// so spending the last credit is allowed (not rejected); consumed lands
		// at the full allowance.
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 1900, bonus: 0 }),
		});
		const { reserveCredits } = await import("../credits");

		await reserveCredits(USER, CREDITS_PER_BUILD, APP);

		expect(setPayload()).toMatchObject({ consumed: 2000 });
	});

	it("throws OutOfCreditsError and never writes when the balance can't cover the cost", async () => {
		// One edit's worth of headroom (5 spendable) cannot cover a 100-credit
		// build: the gate must reject with the typed error AND leave the doc
		// untouched — a rejected reservation books nothing.
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 1995, bonus: 0 }),
		});
		const { OutOfCreditsError, reserveCredits } = await import("../credits");

		await expect(
			reserveCredits(USER, CREDITS_PER_BUILD, APP),
		).rejects.toBeInstanceOf(OutOfCreditsError);
		expect(txSet).not.toHaveBeenCalled();
	});

	it("carries the human-readable message and name on OutOfCreditsError", async () => {
		// The route maps this typed error to a 429; its message is the
		// user-facing reason and its name lets a classifier branch on it.
		const { OutOfCreditsError } = await import("../credits");
		const err = new OutOfCreditsError();
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("OutOfCreditsError");
		expect(err.message).toBe("Out of credits for this period");
	});

	it("rejects on a transaction retry whose re-read shows the balance newly depleted", async () => {
		// Proves the REAL closure is re-runnable and that its read-then-reject path
		// rejects when the re-read shows the balance below the cost. This stands in
		// for what the loser undergoes on contention: the server SDK ABORTs one of
		// two contending transactions and retries it, and the retried `tx.get`
		// returns the snapshot a competitor already depleted — so the SAME
		// read-check-write logic that booked the charge on attempt 1 rejects on
		// attempt 2. The test drives the closure twice with scripted snapshots; it
		// does NOT exercise real commit ordering (an in-process mock can't).
		txGet
			// Attempt 1: balance 100, exactly affordable → would book the charge.
			.mockResolvedValueOnce({
				exists: true,
				data: () => ({ allowance: 2000, consumed: 1900, bonus: 0 }),
			})
			// Attempt 2 (post-abort re-read): a competitor consumed the last 100,
			// so the balance is now 0 < 100 → must reject.
			.mockResolvedValueOnce({
				exists: true,
				data: () => ({ allowance: 2000, consumed: 2000, bonus: 0 }),
			});
		// Drive the closure twice, mirroring Firestore's real retry loop when a
		// concurrent writer commits between our read and our set.
		runTransactionMock.mockImplementationOnce(
			async (
				closure: (tx: {
					get: typeof txGet;
					set: typeof txSet;
				}) => Promise<void>,
			) => {
				await closure({ get: txGet, set: txSet });
				await closure({ get: txGet, set: txSet });
			},
		);
		const { OutOfCreditsError, reserveCredits } = await import("../credits");

		await expect(
			reserveCredits(USER, CREDITS_PER_BUILD, APP),
		).rejects.toBeInstanceOf(OutOfCreditsError);
		// Attempt 1 booked the charge AND co-wrote the marker (two sets); attempt 2
		// re-read the depleted balance and rejected before writing. Under Firestore's
		// real abort-retry the attempt-1 writes never commit (they were on the aborted
		// attempt) — the test asserts the LOGIC each attempt runs and the rejection.
		expect(txSet).toHaveBeenCalledTimes(2);
	});
});

/**
 * Shared driver for the transactional credit writers (`refundReservation`,
 * `resetCredits`, `grantCredits`). Each runs `runTransaction` off a raw ref —
 * `refundReservation` off `appRef.firestore`, the others off `ref.firestore`,
 * both wired to the same hoisted `runTransactionMock` — so this resets the spies
 * and drives the closure once with the spy-backed `tx`. The `runSummary.test.ts`
 * pattern.
 */
function installTransactionDriver(): void {
	txGet.mockReset();
	txSet.mockReset();
	runTransactionMock.mockReset();
	runTransactionMock.mockImplementation(
		async (
			closure: (tx: { get: typeof txGet; set: typeof txSet }) => Promise<void>,
		) => {
			await closure({ get: txGet, set: txSet });
		},
	);
}

/**
 * Pull the merge payload `tx.set` wrote against a specific ref identity. The
 * reset/grant writers set two docs in one transaction — the month doc (`ref`)
 * and the audit row (`grantRef`) — so a payload is selected by WHICH ref it
 * targeted, never by call order. Selecting by identity is what lets the tests
 * pin the two writes independently and survive a future reordering of them.
 */
function payloadForRef(target: unknown): Record<string, unknown> {
	const call = txSet.mock.calls.find(([setRef]) => setRef === target);
	expect(call).toBeDefined();
	return (call as unknown[])[1] as Record<string, unknown>;
}

describe("refundReservation", () => {
	const APP = "app-refund-test";
	const OWNER = "user-refund-test";
	const PERIOD = "2026-06";

	beforeEach(installTransactionDriver);

	/* `refundReservation` reads the APP doc first (for the marker + owner), then the
	 * credit doc — so the scripted `txGet` returns them in that order. The credit
	 * write targets `ref`, the marker-settle write targets `appRef`. */
	function scriptMarkerThenCredit(
		marker: unknown,
		credit: { exists: boolean; data: () => unknown },
	): void {
		txGet
			.mockResolvedValueOnce({
				exists: true,
				data: () => ({ owner: OWNER, reservation: marker }),
			})
			.mockResolvedValueOnce(credit);
	}

	it("un-books the reserved amount and settles the marker in one cross-doc transaction", async () => {
		// An unsettled 100-credit hold on an owner with 250 consumed: the refund
		// walks consumed back to 150 AND flips the marker settled, committed together
		// so the live flush and the reaper can never double-refund the same hold.
		scriptMarkerThenCredit(
			{ period: PERIOD, reserved: CREDITS_PER_BUILD, settled: false },
			{
				exists: true,
				data: () => ({ allowance: 2000, consumed: 250, bonus: 0 }),
			},
		);
		const { refundReservation } = await import("../credits");

		await refundReservation(APP);

		expect(payloadForRef(ref)).toEqual({
			consumed: 250 - CREDITS_PER_BUILD,
			updated_at: FieldValue.serverTimestamp(),
		});
		expect(payloadForRef(appRef)).toEqual({
			reservation: {
				period: PERIOD,
				reserved: CREDITS_PER_BUILD,
				settled: true,
			},
		});
	});

	it("clamps consumed at zero rather than booking a negative balance", async () => {
		// A doc whose consumed (40) is below the refund amount (100). The floor is 0
		// — a refund can never drive consumed negative (the schema would reject it on
		// the next read). consumed lands at 0, not −60.
		scriptMarkerThenCredit(
			{ period: PERIOD, reserved: CREDITS_PER_BUILD, settled: false },
			{
				exists: true,
				data: () => ({ allowance: 2000, consumed: 40, bonus: 0 }),
			},
		);
		const { refundReservation } = await import("../credits");

		await refundReservation(APP);

		expect(payloadForRef(ref)).toMatchObject({ consumed: 0 });
	});

	it("is idempotent — an already-settled marker refunds nothing and writes nothing", async () => {
		// `settled` is the once-guard shared by the live flush and the reaper: a
		// second refund reads settled:true and no-ops, so a hold is never handed back
		// twice. This is what makes the live-and-reaper refund paths collision-safe.
		txGet.mockResolvedValueOnce({
			exists: true,
			data: () => ({
				owner: OWNER,
				reservation: {
					period: PERIOD,
					reserved: CREDITS_PER_BUILD,
					settled: true,
				},
			}),
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP);

		expect(txSet).not.toHaveBeenCalled();
	});

	it("no-ops on an app with no reservation marker (a free turn / pre-reservation app)", async () => {
		// Marker-less generating apps (created before reservations shipped, or whose
		// turn never reserved) carry no hold to refund — the refund is a clean no-op,
		// leaving the reaper to flip status only.
		txGet.mockResolvedValueOnce({
			exists: true,
			data: () => ({ owner: OWNER }),
		});
		const { refundReservation } = await import("../credits");

		await refundReservation(APP);

		expect(txSet).not.toHaveBeenCalled();
	});

	it("settles the marker even when the debited month doc is gone (nothing to un-book)", async () => {
		// A never-debited (or already-reset) month has no credit doc — there is
		// nothing to un-book, but the marker is still settled so the reaper stops
		// revisiting the row on every subsequent list scan.
		scriptMarkerThenCredit(
			{ period: PERIOD, reserved: CREDITS_PER_BUILD, settled: false },
			{ exists: false, data: () => undefined },
		);
		const { refundReservation } = await import("../credits");

		await refundReservation(APP);

		expect(txSet.mock.calls.find(([setRef]) => setRef === ref)).toBeUndefined();
		expect(payloadForRef(appRef)).toEqual({
			reservation: {
				period: PERIOD,
				reserved: CREDITS_PER_BUILD,
				settled: true,
			},
		});
	});
});

describe("resetCredits", () => {
	const USER = "user-reset-test";
	const WHO = {
		actor: "admin-1",
		actorEmail: "admin@dimagi.com",
		reason: "support comp",
	};

	beforeEach(installTransactionDriver);

	it("seeds a complete month doc with consumed zeroed and appends a reset audit row", async () => {
		// An existing mid-period doc (1500 consumed, 200 bonus): a reset must
		// preserve the prior allowance/bonus, zero consumed, AND append the audit
		// row — both writes in one transaction.
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 1500, bonus: 200 }),
		});
		const { resetCredits } = await import("../credits");

		await resetCredits(USER, WHO);

		// Two writes land: the month doc and the grant row.
		expect(txSet).toHaveBeenCalledTimes(2);

		// Month doc: a COMPLETE record — allowance is present (it has no Zod
		// default, so a partial merge would make the next converter read throw),
		// prior bonus preserved, consumed zeroed.
		expect(payloadForRef(ref)).toEqual({
			allowance: 2000,
			consumed: 0,
			bonus: 200,
			updated_at: FieldValue.serverTimestamp(),
		});
		expect(txSet.mock.calls.find(([setRef]) => setRef === ref)?.[2]).toEqual({
			merge: true,
		});

		// Audit row: a reset records amount 0 (it zeroes consumed, adds nothing)
		// plus who/when/why for traceability.
		expect(payloadForRef(grantRef)).toEqual({
			amount: 0,
			type: "reset",
			actor: WHO.actor,
			actor_email: WHO.actorEmail,
			reason: WHO.reason,
			period: getCurrentPeriod(),
			created_at: FieldValue.serverTimestamp(),
		});
	});

	it("seeds the full allowance when resetting a user with no current-period doc", async () => {
		// A reset on a never-touched period must still write a COMPLETE doc: the
		// allowance falls back to the monthly default and bonus to 0, so a later
		// converter-applied read parses cleanly rather than throwing on a missing
		// allowance. A null reason (admin gave none) is recorded verbatim.
		txGet.mockResolvedValue({ exists: false, data: () => undefined });
		const { resetCredits } = await import("../credits");

		await resetCredits(USER, {
			actor: "admin-1",
			actorEmail: "admin@dimagi.com",
			reason: null,
		});

		expect(payloadForRef(ref)).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			updated_at: FieldValue.serverTimestamp(),
		});
		expect(payloadForRef(grantRef)).toMatchObject({
			type: "reset",
			amount: 0,
			reason: null,
		});
	});
});

describe("grantCredits", () => {
	const USER = "user-grant-test";
	const WHO = {
		actor: "admin-1",
		actorEmail: "admin@dimagi.com",
		reason: "beta tester comp",
	};

	beforeEach(installTransactionDriver);

	it("adds to bonus without touching consumed and appends a grant audit row", async () => {
		// A grant ADDS bonus credits — it must never write `consumed`. Writing
		// consumed (even to 0) would silently erase the period's usage, turning a
		// grant into a reset. The existing doc has 300 consumed and 100 bonus;
		// granting 500 lands bonus at 600 and leaves consumed entirely absent from
		// the payload (so the merge preserves the on-disk 300).
		txGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 300, bonus: 100 }),
		});
		const { grantCredits } = await import("../credits");

		await grantCredits(USER, 500, WHO);

		expect(txSet).toHaveBeenCalledTimes(2);

		const monthPayload = payloadForRef(ref);
		expect(monthPayload).toEqual({
			allowance: 2000,
			bonus: 100 + 500,
			updated_at: FieldValue.serverTimestamp(),
		});
		// The load-bearing negative assertion: a grant leaves consumed untouched.
		expect(monthPayload).not.toHaveProperty("consumed");
		expect(txSet.mock.calls.find(([setRef]) => setRef === ref)?.[2]).toEqual({
			merge: true,
		});

		// Audit row records the granted amount and the actor.
		expect(payloadForRef(grantRef)).toEqual({
			amount: 500,
			type: "grant",
			actor: WHO.actor,
			actor_email: WHO.actorEmail,
			reason: WHO.reason,
			period: getCurrentPeriod(),
			created_at: FieldValue.serverTimestamp(),
		});
	});

	it("seeds the full allowance when granting to a user with no current-period doc", async () => {
		// A grant on a never-touched period seeds allowance from the monthly
		// default and starts bonus from 0 + the granted amount — a complete doc so
		// the next converter read parses.
		txGet.mockResolvedValue({ exists: false, data: () => undefined });
		const { grantCredits } = await import("../credits");

		await grantCredits(USER, 250, WHO);

		const monthPayload = payloadForRef(ref);
		expect(monthPayload).toEqual({
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			bonus: 250,
			updated_at: FieldValue.serverTimestamp(),
		});
		expect(monthPayload).not.toHaveProperty("consumed");
		expect(payloadForRef(grantRef)).toMatchObject({
			type: "grant",
			amount: 250,
		});
	});
});

/**
 * `getCreditSummary` over a scripted set of month docs. Unlike the writers, the
 * summary is a plain collection read (`collections.creditMonths(userId).get()`),
 * so it is driven by `creditMonthsGet` (NOT the transaction mock). Each case
 * scripts the on-disk month set as converter-applied snapshots — the docs carry
 * full `CreditMonthDoc` shapes because the read goes through the converter in
 * production.
 */
describe("getCreditSummary", () => {
	const USER = "user-summary-test";

	beforeEach(() => {
		creditMonthsGet.mockReset();
	});

	/** Build a scripted month snapshot keyed by period id. */
	const monthsSnapshot = (
		months: Record<
			string,
			{ allowance: number; consumed: number; bonus: number }
		>,
	) => ({
		docs: Object.entries(months).map(([id, data]) => ({
			id,
			data: () => data,
		})),
	});

	it("reports the current period's balance and sums lifetime consumed across all months", async () => {
		// Three months on disk including the current one. The summary reports the
		// CURRENT period's balance components, while lifetimeConsumed sums consumed
		// over EVERY month (600 + 2000 + 105 = 2705).
		const period = getCurrentPeriod();
		creditMonthsGet.mockResolvedValue(
			monthsSnapshot({
				"2026-04": { allowance: 2000, consumed: 600, bonus: 0 },
				"2026-05": { allowance: 2000, consumed: 2000, bonus: 0 },
				[period]: { allowance: 2000, consumed: 105, bonus: 50 },
			}),
		);
		const { getCreditSummary } = await import("../credits");

		const summary = await getCreditSummary(USER);

		expect(summary).toEqual({
			period,
			allowance: 2000,
			consumed: 105,
			bonus: 50,
			// allowance + bonus − consumed = 2000 + 50 − 105.
			balance: 1945,
			// 600 + 2000 + 105 across the three months.
			lifetimeConsumed: 2705,
		});
	});

	it("reads the current period as a full balance when its doc is absent yet still sums prior months", async () => {
		// The user generated in past months but hasn't this month, so there is no
		// current-period doc. The current balance reads as a fresh full allowance
		// (no pre-seeding write needed), AND lifetimeConsumed still sums the prior
		// months — the combination most easily under-tested.
		const period = getCurrentPeriod();
		creditMonthsGet.mockResolvedValue(
			monthsSnapshot({
				"2026-04": { allowance: 2000, consumed: 300, bonus: 0 },
				"2026-05": { allowance: 2000, consumed: 450, bonus: 0 },
			}),
		);
		const { getCreditSummary } = await import("../credits");

		const summary = await getCreditSummary(USER);

		expect(summary).toEqual({
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			balance: MONTHLY_CREDIT_ALLOWANCE,
			lifetimeConsumed: 750,
		});
	});

	it("reports a full balance and zero lifetime for a user with no months at all", async () => {
		// A brand-new user: no months on disk. The current balance is the full
		// allowance and lifetimeConsumed is 0 — the day-one read with no writes.
		creditMonthsGet.mockResolvedValue(monthsSnapshot({}));
		const { getCreditSummary } = await import("../credits");

		const summary = await getCreditSummary(USER);

		expect(summary).toEqual({
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
 * `getCurrentCreditBalance` — the chat gate's hot-path read. Distinct from
 * `getCreditSummary` in two ways the tests pin: it reads ONE doc (the
 * current-period balance) via `docs.creditMonth(...).get()`, not the whole
 * collection, and it returns just the spendable number. A present doc yields
 * `allowance + bonus − consumed`; an absent doc yields a full allowance (the
 * same absent-doc = full-balance rule the gate and dashboard share), so a
 * brand-new month gates correctly with no pre-seeding write.
 */
describe("getCurrentCreditBalance", () => {
	const USER = "user-balance-test";

	beforeEach(() => {
		creditMonthGet.mockReset();
	});

	it("returns allowance + bonus − consumed for the present current-period doc", async () => {
		creditMonthGet.mockResolvedValue({
			exists: true,
			data: () => ({ allowance: 2000, consumed: 105, bonus: 50 }),
		});
		const { getCurrentCreditBalance } = await import("../credits");

		// 2000 + 50 − 105.
		expect(await getCurrentCreditBalance(USER)).toBe(1945);
	});

	it("returns a full allowance when the current-period doc is absent (no pre-seeding write)", async () => {
		creditMonthGet.mockResolvedValue({ exists: false });
		const { getCurrentCreditBalance } = await import("../credits");

		expect(await getCurrentCreditBalance(USER)).toBe(MONTHLY_CREDIT_ALLOWANCE);
	});
});
