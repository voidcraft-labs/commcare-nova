import { describe, expect, it } from "vitest";
import {
	coerceLookupCell,
	isLookupDate,
	isLookupDatetime,
	isLookupTime,
	validateLookupRowValues,
} from "../coercion";
import type { LookupColumn, LookupId } from "../types";

function id(suffix: number): LookupId {
	return `01890f45-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}` as LookupId;
}

const COLUMNS: LookupColumn[] = [
	{ id: id(1), wireName: "name", label: "Name", dataType: "text" },
	{ id: id(2), wireName: "age", label: "Age", dataType: "int" },
	{ id: id(3), wireName: "score", label: "Score", dataType: "decimal" },
	{ id: id(4), wireName: "dob", label: "Date", dataType: "date" },
	{ id: id(5), wireName: "at", label: "Time", dataType: "time" },
	{
		id: id(6),
		wireName: "seen_at",
		label: "Seen at",
		dataType: "datetime",
	},
];

describe("coerceLookupCell", () => {
	it("keeps empty text and whitespace exact", () => {
		expect(coerceLookupCell("text", "")).toEqual({
			success: true,
			value: "",
		});
		expect(coerceLookupCell("text", "  Ada  ")).toEqual({
			success: true,
			value: "  Ada  ",
		});
		expect(coerceLookupCell("text", null).success).toBe(false);
		expect(coerceLookupCell("text", "bad\0value").success).toBe(false);
		expect(coerceLookupCell("text", "\udfff").success).toBe(false);
	});

	it("accepts typed int4 numbers and strict canonical CSV integers", () => {
		for (const value of [-2_147_483_648, -1, 0, 2_147_483_647]) {
			expect(coerceLookupCell("int", value)).toEqual({
				success: true,
				value,
			});
		}
		for (const value of ["-2147483648", "0", "2147483647"]) {
			expect(coerceLookupCell("int", value, "csv").success).toBe(true);
		}
		for (const value of ["+1", "01", "-0", "1.0", " 1", "2147483648"]) {
			expect(coerceLookupCell("int", value, "csv").success).toBe(false);
		}
		for (const value of [1.5, Infinity, 2_147_483_648, "1"]) {
			expect(coerceLookupCell("int", value).success).toBe(false);
		}
	});

	it("accepts finite JSON decimals and rejects permissive spellings", () => {
		for (const value of [0, -1.5, 1e20]) {
			expect(coerceLookupCell("decimal", value).success).toBe(true);
		}
		for (const value of ["0", "-1.5", "1e+20", "1.0"]) {
			expect(coerceLookupCell("decimal", value, "csv").success).toBe(true);
		}
		for (const value of ["+1", ".5", "1.", "01", "NaN", "1e309"]) {
			expect(coerceLookupCell("decimal", value, "csv").success).toBe(false);
		}
		for (const value of [NaN, Infinity, "1.5"]) {
			expect(coerceLookupCell("decimal", value).success).toBe(false);
		}
	});
});

describe("strict temporal coercion", () => {
	it("matches valid calendar dates", () => {
		expect(isLookupDate("2024-02-29")).toBe(true);
		expect(isLookupDate("2023-02-29")).toBe(false);
		expect(isLookupDate("2026-13-01")).toBe(false);
		expect(isLookupDate("2026-1-01")).toBe(false);
	});

	it("requires an RFC3339 timezone for time and datetime", () => {
		for (const value of ["14:30:00Z", "14:30:00.123-05:00", "14:30:00+05"]) {
			expect(isLookupTime(value)).toBe(true);
		}
		for (const value of ["14:30", "14:30:00", "24:00:00Z", "12:00:00+24:00"]) {
			expect(isLookupTime(value)).toBe(false);
		}
		expect(isLookupDatetime("2026-03-04T14:30:00Z")).toBe(true);
		expect(isLookupDatetime("2026-03-04 14:30:00-0500")).toBe(true);
		expect(isLookupDatetime("2026-03-04T14:30:00")).toBe(false);
		expect(isLookupDatetime("2026-02-30T14:30:00Z")).toBe(false);
	});
});

describe("validateLookupRowValues", () => {
	it("normalizes a complete typed row and permits missing cells", () => {
		const result = validateLookupRowValues(COLUMNS, {
			[id(1).toUpperCase()]: "",
			[id(2)]: 7,
			[id(3)]: 1.25,
			[id(4)]: "2024-02-29",
			[id(5)]: "14:30:00Z",
			[id(6)]: "2026-03-04T14:30:00Z",
		});
		expect(result.success).toBe(true);
		expect(result.values).toEqual({
			[id(1)]: "",
			[id(2)]: 7,
			[id(3)]: 1.25,
			[id(4)]: "2024-02-29",
			[id(5)]: "14:30:00Z",
			[id(6)]: "2026-03-04T14:30:00Z",
		});
		expect(validateLookupRowValues(COLUMNS, {}).success).toBe(true);
	});

	it("rejects unknown UUIDs and non-primitive/type-mismatched values", () => {
		const result = validateLookupRowValues(COLUMNS, {
			[id(99)]: "unknown",
			[id(1)]: false,
			[id(2)]: "7",
			[id(3)]: null,
			[id(4)]: "2023-02-29",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.totalIssueCount).toBe(5);
		expect(result.issues.map((issue) => issue.code)).toEqual([
			"unknown_column",
			"invalid_text",
			"invalid_int",
			"invalid_decimal",
			"invalid_date",
		]);
	});

	it("coerces CSV numerics while retaining source row and bounding details", () => {
		const valid = validateLookupRowValues(
			COLUMNS,
			{ [id(2)]: "7", [id(3)]: "1.25" },
			{ source: "csv", sourceRow: 12 },
		);
		expect(valid.success).toBe(true);
		expect(valid.values).toEqual({ [id(2)]: 7, [id(3)]: 1.25 });

		const manyColumns = Array.from({ length: 120 }, (_, index) => ({
			id: id(index + 1),
			wireName: `c_${index + 1}`,
			label: `Column ${index + 1}`,
			dataType: "int" as const,
		}));
		const bad = Object.fromEntries(
			manyColumns.map((column) => [column.id, "not-an-int"]),
		);
		const result = validateLookupRowValues(manyColumns, bad, {
			source: "csv",
			sourceRow: 8,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.issues).toHaveLength(100);
		expect(result.totalIssueCount).toBe(120);
		expect(result.issues.every((issue) => issue.row === 8)).toBe(true);
	});
});
