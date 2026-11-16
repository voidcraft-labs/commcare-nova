/**
 * The cap phrases of a table CommCare HQ manages. The plausible failure: a
 * size just over a cap printed with ordinary rounding reads as the cap
 * itself ("8 MB of rows (Nova takes 8 MB in one table)"), so a correct
 * refusal reads as a mistake.
 */

import { describe, expect, it } from "vitest";
import {
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_TABLE_BYTES,
} from "../constants";
import { formatLookupBytes, formatLookupBytesOverCap } from "../format";
import { lookupCapExcess } from "../managedRules";

const ONE_FIELD = { fields: ["name"], rows: [] };

describe("lookupCapExcess", () => {
	it("names a size one byte over each cap as more than the cap", () => {
		expect(
			lookupCapExcess(
				{
					fields: ["name"],
					rows: [{ name: "x".repeat(LOOKUP_MAX_CELL_BYTES + 1) }],
				},
				{
					dataBytes: LOOKUP_MAX_TABLE_BYTES + 1,
					largestRowBytes: LOOKUP_MAX_ROW_BYTES + 1,
				},
			),
		).toEqual([
			"a value of 64.1 KB (Nova takes 64 KB in one cell)",
			"a row of 256.1 KB (Nova takes 256 KB in one row)",
			"8.1 MB of rows (Nova takes 8 MB in one table)",
		]);
	});

	it("names a size well over the table cap by its next tenth", () => {
		expect(
			lookupCapExcess(ONE_FIELD, {
				dataBytes: 8_400_000,
				largestRowBytes: 262_150,
			}),
		).toEqual([
			"a row of 256.1 KB (Nova takes 256 KB in one row)",
			"8.1 MB of rows (Nova takes 8 MB in one table)",
		]);
	});

	it("names nothing at exactly each cap", () => {
		expect(
			lookupCapExcess(
				{
					fields: ["name"],
					rows: [{ name: "x".repeat(LOOKUP_MAX_CELL_BYTES) }],
				},
				{
					dataBytes: LOOKUP_MAX_TABLE_BYTES,
					largestRowBytes: LOOKUP_MAX_ROW_BYTES,
				},
			),
		).toEqual([]);
	});
});

describe("formatLookupBytesOverCap", () => {
	it("rounds up where formatLookupBytes rounds to the nearest tenth, and agrees on exact tenths", () => {
		expect(formatLookupBytes(8_400_000)).toBe("8 MB");
		expect(formatLookupBytesOverCap(8_400_000)).toBe("8.1 MB");
		expect(formatLookupBytesOverCap(LOOKUP_MAX_TABLE_BYTES)).toBe("8 MB");
		expect(formatLookupBytesOverCap(1_000)).toBe("1000 bytes");
		expect(formatLookupBytesOverCap(1024 * 1024 - 1)).toBe("1 MB");
	});
});
