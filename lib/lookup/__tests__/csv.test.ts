import { describe, expect, it } from "vitest";
import { LOOKUP_MAX_CSV_BYTES, LOOKUP_MAX_ROWS } from "../constants";
import { parseLookupCsv, validateLookupCsv } from "../csv";
import type { LookupColumn, LookupId } from "../types";

const encoder = new TextEncoder();

function id(suffix: number): LookupId {
	return `01890f45-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}` as LookupId;
}

const COLUMNS: LookupColumn[] = [
	{ id: id(1), wireName: "name", label: "Name", dataType: "text" },
	{ id: id(2), wireName: "age", label: "Age", dataType: "int" },
	{ id: id(3), wireName: "score", label: "Score", dataType: "decimal" },
];

function parse(text: string) {
	return parseLookupCsv(encoder.encode(text));
}

describe("parseLookupCsv — RFC-4180 bytes", () => {
	it("parses BOM, CRLF/LF, quoted separators/newlines, and doubled quotes", () => {
		const result = parse(
			'\uFEFFname,age,score\r\n"Ada, Jr.",7,1.5\n"Line 1\nLine ""two""",,2\r\n',
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value).toEqual({
			headers: ["name", "age", "score"],
			rows: [
				{
					sourceRow: 2,
					values: { name: "Ada, Jr.", age: "7", score: "1.5" },
				},
				{
					sourceRow: 3,
					values: { name: 'Line 1\nLine "two"', score: "2" },
				},
			],
		});
	});

	it("accepts exactly one final empty record caused by a trailing newline", () => {
		expect(parse("name\nAda").success).toBe(true);
		expect(parse("name\nAda\n").success).toBe(true);
		const doubled = parse("name\nAda\n\n");
		expect(doubled.success).toBe(false);
		if (doubled.success) return;
		expect(doubled.details?.[0]).toMatchObject({
			code: "blank_row",
			row: 3,
		});
	});

	it("omits empty cells but preserves every whitespace byte", () => {
		const result = parse("name,age,score\n  Ada  ,, 1.5 \n");
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value.rows[0]).toEqual({
			sourceRow: 2,
			values: { name: "  Ada  ", score: " 1.5 " },
		});
	});

	it("treats prototype-looking wire names as ordinary headers", () => {
		const result = parse("__proto__,constructor\nfirst,second");
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(Object.entries(result.value.rows[0].values)).toEqual([
			["__proto__", "first"],
			["constructor", "second"],
		]);
	});

	it("rejects malformed UTF-8, NUL, and duplicate BOMs", () => {
		const invalidUtf8 = parseLookupCsv(new Uint8Array([0xc3, 0x28]));
		expect(invalidUtf8.success).toBe(false);
		if (!invalidUtf8.success) {
			expect(invalidUtf8.details?.[0].code).toBe("invalid_utf8");
		}
		const nul = parseLookupCsv(new Uint8Array([0x61, 0, 0x62]));
		expect(nul.success).toBe(false);
		if (!nul.success) expect(nul.details?.[0].code).toBe("nul_byte");
		const bom = parse("\uFEFF\uFEFFname\nAda");
		expect(bom.success).toBe(false);
		if (!bom.success) expect(bom.details?.[0].code).toBe("duplicate_bom");
	});

	it("rejects quote grammar, unterminated fields, and bare carriage returns", () => {
		for (const text of [
			'name\n"unterminated',
			'name\nAda"quote',
			'name\n"Ada" trailing',
			"name\rAda",
		]) {
			const result = parse(text);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.details?.[0].code).toBe("malformed_csv");
			}
		}
	});

	it("rejects empty/duplicate headers and inconsistent record widths", () => {
		const empty = parse("name,,age\nAda,x,7");
		expect(empty.success).toBe(false);
		if (!empty.success) expect(empty.details?.[0].code).toBe("empty_header");

		const duplicate = parse("name,name\nAda,Lovelace");
		expect(duplicate.success).toBe(false);
		if (!duplicate.success) {
			expect(duplicate.details?.[0].code).toBe("duplicate_header");
		}

		const width = parse("name,age\nAda\nBob,7,extra");
		expect(width.success).toBe(false);
		if (!width.success) {
			expect(width.totalDetailCount).toBe(2);
			expect(width.details?.map((detail) => detail.row)).toEqual([2, 3]);
		}
	});

	it("rejects more than 250 headers before column binding", () => {
		const headers = Array.from({ length: 251 }, (_, index) => `c_${index}`);
		for (const text of [
			headers.join(","),
			headers.map((header) => `"${header}"`).join(","),
		]) {
			const result = parse(text);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.details).toEqual([
					{
						code: "column_limit",
						row: 1,
						message: "CSV may contain at most 250 columns.",
					},
				]);
			}
		}
	});

	it("rejects over-wide quoted and unquoted data rows while width stays bounded", () => {
		for (const row of ["a,b,c", '"a","b","c"']) {
			const result = parse(`first,second\n${row}`);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.details?.[0]).toMatchObject({
					code: "inconsistent_width",
					row: 2,
				});
			}
		}
	});

	it("enforces raw-byte and row-count limits before persistence", () => {
		const oversized = parseLookupCsv(new Uint8Array(LOOKUP_MAX_CSV_BYTES + 1));
		expect(oversized.success).toBe(false);
		if (!oversized.success) {
			expect(oversized.details?.[0].code).toBe("csv_too_large");
		}

		const tooManyRows = parse(
			`name\n${Array.from({ length: LOOKUP_MAX_ROWS + 1 }, () => "Ada").join("\n")}`,
		);
		expect(tooManyRows.success).toBe(false);
		if (!tooManyRows.success) {
			expect(tooManyRows.details?.[0].code).toBe("row_limit");
			expect(tooManyRows.details?.[0].row).toBe(LOOKUP_MAX_ROWS + 2);
		}
	});
});

describe("validateLookupCsv — definition binding and coercion", () => {
	it("requires an exact complete header set and accepts any header order", () => {
		const reordered = parse("score,name,age\n1.5,Ada,7");
		expect(reordered.success).toBe(true);
		if (!reordered.success) return;
		const result = validateLookupCsv(reordered.value, COLUMNS);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value.rows).toEqual([
			{ [id(1)]: "Ada", [id(2)]: 7, [id(3)]: 1.5 },
		]);

		const wrong = parse("name,unknown\nAda,x");
		expect(wrong.success).toBe(true);
		if (!wrong.success) return;
		const invalid = validateLookupCsv(wrong.value, COLUMNS);
		expect(invalid.success).toBe(false);
		if (invalid.success) return;
		expect(invalid.details?.map((detail) => detail.code)).toEqual([
			"unknown_header",
			"missing_header",
			"missing_header",
		]);
	});

	it("retains wire rows so a locked rename is revalidated, never remapped silently", () => {
		const parsed = parse("name,age,score\nAda,7,1.5");
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(validateLookupCsv(parsed.value, COLUMNS).success).toBe(true);
		const lockedColumns = COLUMNS.map((column) =>
			column.wireName === "age" ? { ...column, wireName: "years" } : column,
		);
		const stale = validateLookupCsv(parsed.value, lockedColumns);
		expect(stale.success).toBe(false);
		if (stale.success) return;
		expect(stale.details?.map((detail) => detail.code)).toContain(
			"unknown_header",
		);
		expect(stale.details?.map((detail) => detail.code)).toContain(
			"missing_header",
		);
	});

	it("collects all coercion errors while returning at most 100 details", () => {
		const columns = Array.from({ length: 120 }, (_, index) => ({
			id: id(index + 1),
			wireName: `c_${index + 1}`,
			label: `Column ${index + 1}`,
			dataType: "int" as const,
		}));
		const headers = columns.map((column) => column.wireName).join(",");
		const values = columns.map(() => "bad").join(",");
		const parsed = parse(`${headers}\n${values}`);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const result = validateLookupCsv(parsed.value, columns);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.details).toHaveLength(100);
		expect(result.totalDetailCount).toBe(120);
	});

	it("treats an empty CSV cell as missing even for text", () => {
		const parsed = parse("name,age,score\n,7,");
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const result = validateLookupCsv(parsed.value, COLUMNS);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.value.rows).toEqual([{ [id(2)]: 7 }]);
	});
});
