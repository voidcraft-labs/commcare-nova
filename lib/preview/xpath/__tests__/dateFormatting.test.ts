import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCommCareDate, formatTimezoneOffset } from "../dateFormatting";
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
			text: "2026 26 07 7 July Jul 14 14 18 18 05 06 007 Tuesday Tue 2 Z % 2026",
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
