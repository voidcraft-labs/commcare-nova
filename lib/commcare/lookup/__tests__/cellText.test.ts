import { describe, expect, it } from "vitest";
import type { LookupDataType } from "@/lib/lookup/types";
import { lookupFixtureCellText } from "../cellText";

const ALL_TYPES: readonly LookupDataType[] = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
];

describe("lookupFixtureCellText", () => {
	it("projects an undefined cell to empty text for every data type", () => {
		for (const type of ALL_TYPES) {
			expect(lookupFixtureCellText(type, undefined)).toBe("");
		}
	});

	it("passes text and temporal cells through byte-identically", () => {
		expect(lookupFixtureCellText("text", "hello")).toBe("hello");
		expect(lookupFixtureCellText("date", "2026-07-23")).toBe("2026-07-23");
		expect(lookupFixtureCellText("time", "13:45:00")).toBe("13:45:00");
		expect(lookupFixtureCellText("datetime", "2026-07-23T13:45:00.000Z")).toBe(
			"2026-07-23T13:45:00.000Z",
		);
	});

	it("preserves surrounding whitespace in a text cell without trimming", () => {
		expect(lookupFixtureCellText("text", "  padded value \t")).toBe(
			"  padded value \t",
		);
	});

	it("keeps a stored empty text cell empty (absence lives only in storage)", () => {
		expect(lookupFixtureCellText("text", "")).toBe("");
	});

	it("renders an int cell as its canonical signed base-10 spelling", () => {
		expect(lookupFixtureCellText("int", 0)).toBe("0");
		expect(lookupFixtureCellText("int", -12)).toBe("-12");
		expect(lookupFixtureCellText("int", 2147483647)).toBe("2147483647");
	});

	it("renders a decimal cell as an exponent-free plain decimal", () => {
		expect(lookupFixtureCellText("decimal", 0)).toBe("0");
		expect(lookupFixtureCellText("decimal", 0.1)).toBe("0.1");
		expect(lookupFixtureCellText("decimal", -2.5)).toBe("-2.5");
		// `String(1e21)` would be "1e+21", which Core's numeric coercion
		// rejects as NaN; the wire spelling expands the exponent away and
		// matches every predicate literal's formatNumeric spelling.
		expect(lookupFixtureCellText("decimal", 1e21)).toBe(
			"1000000000000000000000",
		);
		expect(lookupFixtureCellText("decimal", 1e-7)).toBe("0.0000001");
	});

	it("throws a reader-bug error when a text column stores a number", () => {
		expect(() => lookupFixtureCellText("text", 5)).toThrow(/reader bug/);
	});

	it("throws a reader-bug error when an int column stores a string", () => {
		expect(() => lookupFixtureCellText("int", "5")).toThrow(/reader bug/);
	});
});
