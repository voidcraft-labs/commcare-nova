import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { nextValues, rowMatchesWhere } from "../auth-firestore-increment";

/**
 * The guard clauses below are the literal shapes Better Auth's database rate
 * limiter and API-key plugin pass to `incrementOne`. The atomic compare-and-
 * swap only holds if every operator is evaluated exactly, so these assert the
 * real where-clauses rather than synthetic ones.
 */
describe("rowMatchesWhere — rate-limiter guards", () => {
	const key = "1.2.3.4:/api/auth/get-session";

	it("admits an in-window request below the cap", () => {
		const row = { key, count: 3, lastRequest: 1_000 };
		const where = [
			{ field: "key", value: key },
			{ field: "lastRequest", operator: "gt" as const, value: 500 },
			{ field: "count", operator: "lt" as const, value: 5 },
		];
		expect(rowMatchesWhere(row, where)).toBe(true);
	});

	it("rejects once the counter is at the cap", () => {
		const row = { key, count: 5, lastRequest: 1_000 };
		const where = [
			{ field: "key", value: key },
			{ field: "lastRequest", operator: "gt" as const, value: 500 },
			{ field: "count", operator: "lt" as const, value: 5 },
		];
		expect(rowMatchesWhere(row, where)).toBe(false);
	});

	it("rejects when the window has rolled past lastRequest", () => {
		const row = { key, count: 1, lastRequest: 400 };
		const where = [
			{ field: "key", value: key },
			{ field: "lastRequest", operator: "gt" as const, value: 500 },
			{ field: "count", operator: "lt" as const, value: 5 },
		];
		expect(rowMatchesWhere(row, where)).toBe(false);
	});

	it("guards the reset path on an unchanged lastRequest (compare-and-swap)", () => {
		const where = [
			{ field: "key", value: key },
			{ field: "lastRequest", operator: "lte" as const, value: 1_000 },
		];
		expect(rowMatchesWhere({ key, count: 9, lastRequest: 1_000 }, where)).toBe(
			true,
		);
		// A concurrent writer already bumped lastRequest — the CAS must miss.
		expect(rowMatchesWhere({ key, count: 9, lastRequest: 1_001 }, where)).toBe(
			false,
		);
	});
});

describe("rowMatchesWhere — api-key guards", () => {
	it("decrements remaining only while it is still positive", () => {
		const where = [
			{ field: "id", value: "key_abc" },
			{ field: "remaining", operator: "gt" as const, value: 0 },
		];
		expect(rowMatchesWhere({ id: "key_abc", remaining: 1 }, where)).toBe(true);
		expect(rowMatchesWhere({ id: "key_abc", remaining: 0 }, where)).toBe(false);
	});

	it("treats `eq null` as matching an unset field", () => {
		const where = [
			{ field: "lastRequest", operator: "eq" as const, value: null },
		];
		expect(rowMatchesWhere({ lastRequest: null }, where)).toBe(true);
		expect(rowMatchesWhere({}, where)).toBe(true);
		expect(rowMatchesWhere({ lastRequest: 1 }, where)).toBe(false);
	});

	it("compares stored Firestore Timestamps against Date guards by instant", () => {
		const stored = Timestamp.fromMillis(2_000);
		const where = [
			{ field: "lastRequest", operator: "gt" as const, value: new Date(1_000) },
		];
		expect(rowMatchesWhere({ lastRequest: stored }, where)).toBe(true);
		expect(
			rowMatchesWhere({ lastRequest: Timestamp.fromMillis(500) }, where),
		).toBe(false);
	});

	it("throws on an operator it cannot evaluate, rather than silently passing", () => {
		const where = [
			{ field: "name", operator: "contains" as const, value: "x" },
		];
		expect(() => rowMatchesWhere({ name: "xyz" }, where)).toThrow(
			/does not support/,
		);
	});
});

describe("nextValues", () => {
	it("increments the counter and stamps the new lastRequest (in-window path)", () => {
		const values = nextValues(
			{ count: 3, lastRequest: 500 },
			{ count: 1 },
			{
				lastRequest: 1_000,
			},
		);
		expect(values).toEqual({ count: 4, lastRequest: 1_000 });
	});

	it("applies a pure set with no increment (reset path)", () => {
		const values = nextValues(
			{ count: 9, lastRequest: 500 },
			{},
			{
				count: 1,
				lastRequest: 1_000,
			},
		);
		expect(values).toEqual({ count: 1, lastRequest: 1_000 });
	});

	it("treats a missing or non-numeric field as zero before incrementing", () => {
		expect(nextValues({}, { count: 1 }, {})).toEqual({ count: 1 });
		expect(nextValues({ count: "oops" }, { count: 2 }, {})).toEqual({
			count: 2,
		});
	});

	it("decrements (negative delta) for quota consumption", () => {
		expect(nextValues({ remaining: 5 }, { remaining: -1 }, {})).toEqual({
			remaining: 4,
		});
	});

	it("lets an increment override a set on the same field", () => {
		expect(nextValues({ count: 7 }, { count: 1 }, { count: 99 })).toEqual({
			count: 8,
		});
	});
});
