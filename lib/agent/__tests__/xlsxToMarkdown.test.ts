/**
 * Tests for `xlsxToMarkdown`'s formula extraction — the `#### Calculations`
 * appendix that surfaces a sheet's formulas (the derivation logic the SA can
 * rebuild as CommCare calculated fields) alongside the computed-value table.
 * `sheet_to_json` reports only computed values, so this appendix is the ONLY
 * place that logic survives the office→markdown conversion.
 */

import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { xlsxToMarkdown } from "../documentExtraction";

/* Importing `documentExtraction` pulls in mammoth, which pulls in bluebird —
 * bluebird creates a module-level promise at import time that the async-leak
 * detector flags (failing the pre-push gate). `xlsxToMarkdown` never touches
 * mammoth, so mocking it at the import boundary keeps the real module (and
 * bluebird) from loading; matches the sibling extraction tests. */
vi.mock("mammoth", () => ({
	default: {
		convertToMarkdown: vi.fn(async () => ({ value: "" })),
	},
}));

/** Build an .xlsx buffer from a map of sheet name → array-of-arrays. A cell may
 *  be a primitive (value) or a `CellObject` carrying a formula (`f`). Writing
 *  then re-reading mirrors how a real upload round-trips through SheetJS. */
function workbookBuffer(
	sheets: Record<string, (string | number | XLSX.CellObject)[][]>,
): Buffer {
	const wb = XLSX.utils.book_new();
	for (const [name, aoa] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
	}
	return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("xlsxToMarkdown", () => {
	it("appends a #### Calculations block listing each formula cell while keeping computed values in the table", () => {
		const buffer = workbookBuffer({
			Orders: [
				["item", "qty", "price", "amount"],
				["apple", 3, 2, { t: "n", v: 6, f: "B2*C2" }],
				["total", "", "", { t: "n", v: 6, f: "SUM(D2:D2)" }],
			],
		});

		const md = xlsxToMarkdown(buffer);

		// The values table still carries the sheet heading + computed data.
		expect(md).toContain("### Orders");
		expect(md).toContain("apple");
		// The derivation logic surfaces as an h4 appendix, one line per formula
		// cell, addressed in A1 notation (SheetJS stores `f` without the `=`).
		expect(md).toContain("#### Calculations");
		expect(md).toContain("- D2 = B2*C2");
		expect(md).toContain("- D3 = SUM(D2:D2)");
	});

	it("omits the Calculations block for a value-only sheet", () => {
		const buffer = workbookBuffer({
			PlainData: [
				["a", "b"],
				[1, 2],
			],
		});

		const md = xlsxToMarkdown(buffer);

		expect(md).toContain("### PlainData");
		expect(md).not.toContain("#### Calculations");
	});

	it("clamps the value table to a bounded window on a large/sparse range and still finds a formula via the populated-cell scan", () => {
		// A worksheet declaring a 5000-row range but holding a handful of cells,
		// one a formula far down the sheet. A malicious doc can declare a
		// ~17-billion-cell `!ref`; the clamp (table read window) + the populated-
		// cell formula scan are what keep that from walking the declared range.
		// Built sparse (cells set directly) so the writer doesn't materialize the
		// range. This asserts the clamp BEHAVIOR — the mechanism that prevents the
		// DoS — which the old full-range walk would fail (no note, all rows).
		const ws: XLSX.WorkSheet = {
			"!ref": "A1:B5000",
			A1: { t: "s", v: "label" },
			A2: { t: "s", v: "row2" },
			B2: { t: "n", v: 6, f: "A2*C2" },
			A5000: { t: "s", v: "far-down" },
		};
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Sparse");
		const buffer = XLSX.write(wb, {
			type: "buffer",
			bookType: "xlsx",
		}) as Buffer;

		const md = xlsxToMarkdown(buffer);

		// The table is clamped + flagged (5000 rows > the 2000-row window).
		expect(md).toContain("table truncated to the first 2000 rows");
		// The formula is still found — the scan walks populated cells, not the
		// declared range, so a cell anywhere in the sheet surfaces.
		expect(md).toContain("#### Calculations");
		expect(md).toContain("- B2 = A2*C2");
		// Bounded output — not a dump of the full declared range.
		expect(md.length).toBeLessThan(100_000);
	});
});
