import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	formatCommCareDate,
	formatConcreteCommCareDate,
	formatTimezoneOffset,
} from "../dateFormatting";
import { XPathDate } from "../types";

const originalTimeZone = process.env.TZ;

describe("formatCommCareDate", () => {
	beforeAll(() => {
		process.env.TZ = "UTC";
	});

	afterAll(() => {
		if (originalTimeZone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTimeZone;
		}
	});

	it("implements JavaRosa's supported token set, including repeats", () => {
		const value = requireDate("2026-07-14T18:05:06.007Z");
		expect(
			formatCommCareDate(
				value,
				"%Y %y %m %n %B %b %d %e %H %h %M %S %3 %A %a %w %Z %% %Y",
			),
		).toEqual({
			kind: "formatted",
			// DateUtils truncates 1000 * the parsed fractional double, so the
			// binary representation of .007 produces 6 milliseconds in Core.
			text: "2026 26 07 7 July Jul 14 14 18 18 05 06 006 Tuesday Tue 2 Z % 2026",
		});
	});

	it.each([
		["short", "07/14/2026"],
		["long", "July 14, 2026"],
		["iso", "2026-07-14"],
	] as const)("resolves the %s semantic preset", (preset, expected) => {
		expect(formatCommCareDate(requireDate("2026-07-14"), preset)).toEqual({
			kind: "formatted",
			text: expected,
		});
	});

	it("keeps the concrete column vocabulary distinct from semantic presets", () => {
		expect(
			formatConcreteCommCareDate(requireDate("2026-07-14"), "short"),
		).toEqual({
			kind: "formatted",
			text: "short",
		});
	});

	it("reports unknown and trailing escapes instead of approximating", () => {
		const value = requireDate("2026-07-14");
		expect(formatCommCareDate(value, "%Q")).toEqual({
			kind: "unsupported-pattern",
		});
		expect(formatCommCareDate(value, "Date %")).toEqual({
			kind: "unsupported-pattern",
		});
	});

	it("rejects a normalized-but-invalid calendar date", () => {
		expect(XPathDate.parse("2026-02-31")).toBeNull();
		expect(XPathDate.parse("2024-02-30T12:00")).toBeNull();
	});

	it("matches DateUtils' explicit whitespace and time grammar", () => {
		expect(XPathDate.parse(" 2024-02-29")).toBeNull();
		expect(XPathDate.parse("2024-02-29 ")).toBeNull();
		expect(XPathDate.parse("2024-02-29T01:02")).not.toBeNull();
		expect(
			formatCommCareDate(
				requireDate("2024-02-29T01:02:03.4567"),
				"%H:%M:%S.%3",
			),
		).toEqual({ kind: "formatted", text: "01:02:03.456" });
		// parseRawTime consumes the numeric seconds prefix, as pinned Core does.
		expect(
			formatCommCareDate(
				requireDate("2024-02-29T01:02:03.5tail"),
				"%H:%M:%S.%3",
			),
		).toEqual({ kind: "formatted", text: "01:02:03.500" });
	});

	it("applies offsets to the clock but retains the authored date fields", () => {
		process.env.TZ = "America/Los_Angeles";
		try {
			const utc = requireDate("2024-01-01T01:30Z");
			expect(utc.toISOString()).toBe("2024-01-01");
			expect(formatCommCareDate(utc, "%Y-%m-%d %H:%M")).toEqual({
				kind: "formatted",
				text: "2024-01-01 17:30",
			});

			const positive = requireDate("2024-01-01T01:30+02:00");
			expect(formatCommCareDate(positive, "%Y-%m-%d %H:%M")).toEqual({
				kind: "formatted",
				text: "2024-01-01 15:30",
			});

			const negative = requireDate("2024-01-01T23:30-02:00");
			expect(formatCommCareDate(negative, "%Y-%m-%d %H:%M")).toEqual({
				kind: "formatted",
				text: "2024-01-01 17:30",
			});
		} finally {
			process.env.TZ = "UTC";
		}
	});

	it("accepts years 0001-0099 like JavaRosa's DateFields.check()", () => {
		// JavaRosa range-checks only month and day, so a typed-year typo
		// like "0021-06-15" parses, formats, and filters normally on
		// device — Preview must parse it too. (A `Date.UTC(21, ...)`
		// construction would remap the year to 1921 and reject it.)
		const parsed = XPathDate.parse("0021-06-15");
		expect(parsed).not.toBeNull();
		expect(parsed?.toISOString()).toBe("21-06-15");
		expect(XPathDate.parse("0099-12-31")).not.toBeNull();
		// The calendar-validity guard still applies within the range.
		expect(XPathDate.parse("0021-02-30")).toBeNull();
	});
});

describe("formatTimezoneOffset", () => {
	it.each([
		[0, "Z"],
		[60, "+01"],
		[-420, "-07"],
		[330, "+05:30"],
		[-330, "-05:30"],
		// JavaRosa (`DateUtils.getOffsetInStandardFormat`) keys the shape on
		// the truncated HOURS field: a sub-hour offset renders `Z:MM` with
		// the sign dropped, for both directions.
		[30, "Z:30"],
		[-30, "Z:30"],
	] as const)("renders %d minutes as %s (JavaRosa shape)", (minutes, text) => {
		expect(formatTimezoneOffset(minutes)).toBe(text);
	});
});

function requireDate(raw: string): XPathDate {
	const value = XPathDate.parse(raw);
	if (value === null) throw new Error(`Invalid date fixture: ${raw}`);
	return value;
}
