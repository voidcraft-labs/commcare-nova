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

const u = (role: "user" | "assistant"): UIMessage =>
	({ id: "m", role, parts: [{ type: "text", text: "x" }] }) as UIMessage;

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
