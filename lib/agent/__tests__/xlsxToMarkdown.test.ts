/**
 * Tests for `xlsxToMarkdown`'s formula extraction — the `#### Calculations`
 * appendix that surfaces a sheet's formulas (the derivation logic the SA can
 * rebuild as CommCare calculated fields) alongside the computed-value table.
 * `sheet_to_json` reports only computed values, so this appendix is the ONLY
 * place that logic survives the office→markdown conversion.
 */

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { xlsxToMarkdown } from "../documentExtraction";

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
});
