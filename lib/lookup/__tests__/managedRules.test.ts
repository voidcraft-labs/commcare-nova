/**
 * The bounds of one inline copy of a table CommCare HQ manages. The plausible
 * failures: a bound judged one off at its edge, and a size just over a bound
 * printed with ordinary rounding as the bound itself ("8 MB of rows"), so a
 * correct refusal reads as a mistake.
 */

import { describe, expect, it } from "vitest";
import {
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_CHANGE_BYTES,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
} from "../constants";
import { formatLookupBytes, formatLookupBytesOverCap } from "../format";
import {
	lookupInlineCopyExcess,
	managedLookupInlineCopyRefusal,
} from "../managedRules";

const ONE_FIELD = { fields: ["name"], rows: [] };

describe("lookupInlineCopyExcess", () => {
	it("names a size one byte over each cap as more than the cap", () => {
		expect(
			lookupInlineCopyExcess(
				{
					fields: ["name"],
					rows: [{ name: "x".repeat(LOOKUP_MAX_CELL_BYTES + 1) }],
				},
				{
					dataBytes: LOOKUP_MAX_CHANGE_BYTES + 1,
					largestRowBytes: LOOKUP_MAX_ROW_BYTES + 1,
				},
			),
		).toEqual(["a value of 64.1 KB", "a row of 256.1 KB", "8.1 MB of rows"]);
	});

	it("names a size well over the copy bound by its next tenth", () => {
		expect(
			lookupInlineCopyExcess(ONE_FIELD, {
				dataBytes: 8_400_000,
				largestRowBytes: 262_150,
			}),
		).toEqual(["a row of 256.1 KB", "8.1 MB of rows"]);
	});

	it("counts rows and columns one past what one inline copy writes, and nothing at it", () => {
		const fields = (n: number) =>
			Array.from({ length: n }, (_, index) => `f${index}`);
		const rows = (n: number) => Array.from({ length: n }, () => ({}));
		const none = { dataBytes: 0, largestRowBytes: 0 };
		expect(
			lookupInlineCopyExcess(
				{ fields: fields(LOOKUP_MAX_COLUMNS), rows: rows(LOOKUP_MAX_ROWS) },
				none,
			),
		).toEqual([]);
		expect(
			lookupInlineCopyExcess(
				{
					fields: fields(LOOKUP_MAX_COLUMNS + 1),
					rows: rows(LOOKUP_MAX_ROWS + 1),
				},
				none,
			),
		).toEqual(["5,001 rows", "251 columns"]);
	});

	it("offers the paged refresh, never a shorter table, when one inline copy cannot carry it", () => {
		expect(managedLookupInlineCopyRefusal("districts", ["5,001 rows"])).toBe(
			"The lookup table districts has 5,001 rows in CommCare HQ, more than Nova copies in one read, so nothing was written. Nova reads a table this size in pages when you refresh it from Project data.",
		);
	});

	it("names nothing at exactly each cap", () => {
		expect(
			lookupInlineCopyExcess(
				{
					fields: ["name"],
					rows: [{ name: "x".repeat(LOOKUP_MAX_CELL_BYTES) }],
				},
				{
					dataBytes: LOOKUP_MAX_CHANGE_BYTES,
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
		expect(formatLookupBytesOverCap(LOOKUP_MAX_CHANGE_BYTES)).toBe("8 MB");
		expect(formatLookupBytesOverCap(1_000)).toBe("1000 bytes");
		expect(formatLookupBytesOverCap(1024 * 1024 - 1)).toBe("1 MB");
	});
});
