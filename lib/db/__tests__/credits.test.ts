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
import { Timestamp } from "@google-cloud/firestore";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
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
import { creditGrantDocSchema, creditMonthDocSchema } from "@/lib/db/types";

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
