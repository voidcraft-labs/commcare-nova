import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	instantTextOfMicros,
	literalInstantMicros,
	literalInstantText,
} from "../instantOperand";

/** A literal's moment, read by the checker's own grammar. */
function micros(text: string): number {
	const value = literalInstantMicros(text);
	if (value === undefined) throw new Error(`${text} names no moment.`);
	return value;
}

// Past 2^53 a double holds every 8th to 32nd microsecond here, so each edge
// is a moment a double holds exactly: the fold computes no other.
const FIRST = micros("0000-01-01T00:00:00Z");
const FIRST_PAST = micros("9999-12-31T23:00:00-01:00");
const LAST_UTC = FIRST_PAST - 32;
const LAST_SPELLED = micros("9999-12-31T23:59:59-99:00");

const THOUSAND = BigInt(1000);

/** Both laws: the text folds back to the count, and it is canonical. */
function holdsLaws(count: number): void {
	const text = instantTextOfMicros(count);
	expect(text).toBeDefined();
	if (text === undefined) return;
	expect(literalInstantMicros(text)).toBe(count);
	expect(literalInstantText(text)).toBe(text);
}

describe("instantTextOfMicros", () => {
	it("spells a moment in UTC, with three fraction digits for whole milliseconds", () => {
		expect(instantTextOfMicros(0)).toBe("1970-01-01T00:00:00.000Z");
		expect(instantTextOfMicros(micros("2026-03-04T05:06:07.123Z"))).toBe(
			"2026-03-04T05:06:07.123Z",
		);
		expect(instantTextOfMicros(micros("2026-03-04T05:06:07.123456Z"))).toBe(
			"2026-03-04T05:06:07.123456Z",
		);
		expect(instantTextOfMicros(micros("1969-12-31T23:59:59.999999Z"))).toBe(
			"1969-12-31T23:59:59.999999Z",
		);
		expect(instantTextOfMicros(micros("2026-01-01T00:00:00+05:30"))).toBe(
			"2025-12-31T18:30:00.000Z",
		);
	});

	it("keeps the edges of the years 0000 and 9999 in UTC", () => {
		expect(instantTextOfMicros(FIRST)).toBe("0000-01-01T00:00:00.000Z");
		expect(instantTextOfMicros(micros("9999-12-31T23:59:59Z"))).toBe(
			"9999-12-31T23:59:59.000Z",
		);
		expect(instantTextOfMicros(LAST_UTC)).toBe("9999-12-31T23:59:59.999968Z");
		expect(instantTextOfMicros(FIRST - 8)).toBeUndefined();
	});

	it("spells a moment past 9999 in UTC at the smallest whole hour behind it", () => {
		expect(instantTextOfMicros(FIRST_PAST)).toBe(
			"9999-12-31T23:00:00.000-01:00",
		);
		// Nova's own literal whose UTC moment is in the year 10000.
		expect(instantTextOfMicros(micros("9999-12-31T23:59:59-05:00"))).toBe(
			"9999-12-31T23:59:59.000-05:00",
		);
		const hundredHours = FIRST_PAST + 100 * 3600 * 1_000_000;
		expect(instantTextOfMicros(hundredHours)).toBeUndefined();
		expect(instantTextOfMicros(LAST_SPELLED)).toBe(
			"9999-12-31T23:59:59.000-99:00",
		);
		expect(instantTextOfMicros(LAST_SPELLED + 1_000_000)).toBeUndefined();
	});

	it("answers no text for a count that is no integer", () => {
		expect(instantTextOfMicros(0.5)).toBeUndefined();
		expect(instantTextOfMicros(Number.NaN)).toBeUndefined();
		expect(instantTextOfMicros(Number.POSITIVE_INFINITY)).toBeUndefined();
	});

	it("holds both laws over every moment a four-digit year spells", () => {
		holdsLaws(FIRST);
		holdsLaws(LAST_UTC);
		holdsLaws(FIRST_PAST);
		holdsLaws(LAST_SPELLED);
		fc.assert(
			fc.property(
				fc
					.bigInt({ min: BigInt(FIRST), max: BigInt(LAST_SPELLED) })
					.map((value) => Number(value)),
				holdsLaws,
			),
			{ numRuns: 2000 },
		);
		// Whole milliseconds, which spell three fraction digits, up to the
		// largest count a double holds to the microsecond.
		fc.assert(
			fc.property(
				fc
					.bigInt({
						min: BigInt(FIRST) / THOUSAND,
						max: BigInt(Number.MAX_SAFE_INTEGER) / THOUSAND,
					})
					.map((value) => Number(value * THOUSAND)),
				(count) => {
					holdsLaws(count);
					expect(instantTextOfMicros(count)).toMatch(/\.\d{3}(Z|-\d{2}:00)$/);
				},
			),
			{ numRuns: 500 },
		);
	});
});
