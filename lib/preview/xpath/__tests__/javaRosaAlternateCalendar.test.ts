import { describe, expect, it } from "vitest";
import { javaRosaFormatDateForCalendar } from "../javaRosaAlternateCalendar";
import { XPathDate } from "../types";

describe("JavaRosa alternate-calendar formatting", () => {
	it("matches Core's Ethiopian and Nepali conversion fixtures", () => {
		const date = XPathDate.parse("2017-07-15");
		expect(javaRosaFormatDateForCalendar(date, "ethiopian", "%Y-%m-%d")).toBe(
			"2009-11-08",
		);
		expect(javaRosaFormatDateForCalendar(date, "nepali", "%Y-%m-%d")).toBe(
			"2074-03-31",
		);
	});

	it("uses Android's pinned localized month arrays", () => {
		const date = XPathDate.parse("2017-07-15");
		expect(
			javaRosaFormatDateForCalendar(date, "ethiopian", undefined, "am"),
		).toBe("8 ሐምሌ 2009");
		expect(javaRosaFormatDateForCalendar(date, "nepali", "%B", "ne-NP")).toBe(
			"आषाढ",
		);
		expect(
			javaRosaFormatDateForCalendar(date, "ethiopian", undefined, "amh"),
		).toBe("8 ሐምሌ 2009");
		expect(javaRosaFormatDateForCalendar(date, "nepali", "%B", "nep")).toBe(
			"आषाढ",
		);
		expect(javaRosaFormatDateForCalendar(date, "ethiopian", "%B", "spa")).toBe(
			"Hamlie",
		);
		expect(javaRosaFormatDateForCalendar(date, "ethiopian", "%B", "swh")).toBe(
			"Hamlie",
		);
	});

	it("matches empty, unsupported-calendar, and bounds behavior", () => {
		expect(javaRosaFormatDateForCalendar(null, "ethiopian")).toBe("");
		expect(() =>
			javaRosaFormatDateForCalendar(XPathDate.fromDays(0), "neverland"),
		).toThrow("Unsupported calendar");
		expect(() =>
			javaRosaFormatDateForCalendar(XPathDate.parse("2200-01-01"), "nepali"),
		).toThrow("out of bounds");
		expect(() =>
			javaRosaFormatDateForCalendar(XPathDate.parse("0015-01-01"), "nepali"),
		).toThrow("out of bounds");
	});
});
