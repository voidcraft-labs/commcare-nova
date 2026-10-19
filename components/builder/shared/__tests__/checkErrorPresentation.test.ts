import { describe, expect, it } from "vitest";
import type { CheckError } from "@/lib/domain/expression";
import { presentCheckErrorForEditor } from "../checkErrorPresentation";

describe("PredicateCardEditor — user-facing diagnostics", () => {
	it.each([
		[
			"property",
			{ code: "unknown-property", path: ["left"] },
			"Choose available case information",
		],
		[
			"value type",
			{ code: "incompatible-values", path: ["right"] },
			"Choose values that use compatible kinds of information",
		],
		[
			"search question",
			{ code: "unknown-search-input", path: ["input"] },
			"Choose an available Search field",
		],
		[
			"relationship",
			{ code: "relation-path", path: ["via"] },
			"Choose an available connection to another case",
		],
		[
			"relationship destination",
			{ code: "relation-destination", path: ["via"] },
			"Choose a connection that leads to an available kind of case",
		],
		[
			"matching property",
			{ code: "match-value", path: ["property"] },
			"Choose other case information or a different matching method",
		],
		[
			"empty matching value",
			{ code: "match-value-empty", path: ["value"] },
			"Enter a value to match",
		],
		[
			"built-in case status",
			{ code: "case-status-value", path: ["right"] },
			"Use open or closed for built-in case status",
		],
		[
			"unordered value",
			{ code: "ordered-values", path: ["left"] },
			"Use numbers or dates for this comparison",
		],
		[
			"time of day ordering",
			{ code: "time-ordering", path: ["left"] },
			"A time of day can't be compared with before or after. A date can be compared this way.",
		],
	] as const)(
		"presents a next action for %s errors",
		(_label, finding, copy) => {
			const error: CheckError = {
				code: finding.code,
				path: [...finding.path],
				message: "Detailed checker prose that must stay out of the UI",
			};
			expect(presentCheckErrorForEditor(error)).toBe(copy);
		},
	);

	it.each([
		[["property"], "Choose available case information"],
		[["input"], "Choose an available Search field"],
		[["via"], "Choose an available connection to another case"],
		[["right"], "Choose a value that works here"],
	] as const)(
		"keeps a path-specific next action for an unknown diagnostic at %j",
		(path, copy) => {
			const futureError = {
				path: [...path],
				code: "future-checker-category",
				message: "Raw future checker detail",
			} as unknown as CheckError;
			expect(presentCheckErrorForEditor(futureError)).toBe(copy);
		},
	);
});

describe("PredicateCardEditor — reasons and the checker's newer codes", () => {
	const present = (code: CheckError["code"], reason?: string) =>
		presentCheckErrorForEditor({
			code,
			path: ["right"],
			message: "Detailed checker prose that must stay out of the UI",
			...(reason === undefined ? {} : { reason }),
		});

	it.each([
		[
			"date-datetime",
			"A date and a date and time don't line up. You can wrap the date and time in date() to compare days",
		],
		[
			"datetime-ordering",
			"A date and time can only be ordered against another date and time. You can wrap it in date() to compare days",
		],
		[
			"boolean",
			"Anything that isn't blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own",
		],
	])(
		"gives values that don't line up for %s their own line",
		(reason, copy) => {
			expect(present("incompatible-values", reason)).toBe(copy);
		},
	);

	it.each([
		[
			"clock-lost",
			"This value has kept only the day of a date and time. You can compare the date and time that first recorded it, or wrap both sides in date() to compare days",
		],
		[
			"unreadable-datetime",
			"CommCare can't read this date and time. You can write it like 2026-01-02T10:30:00Z",
		],
		[
			"datetime-equality",
			"A date and time never matches something that isn't one. You can compare it with another date and time, or check whether it's blank",
		],
		[
			"day-only-on-device",
			"A device keeps only the day a case was opened or last changed. You can compare it with a date instead",
		],
	])(
		"gives a comparison a device can't run between moments, %s, its own line",
		(reason, copy) => {
			expect(present("incompatible-values", reason)).toBe(copy);
		},
	);

	it("names the system date a device keeps as its day", () => {
		const dayOnly = (instant: CheckError["instant"]) =>
			presentCheckErrorForEditor({
				code: "incompatible-values",
				path: [],
				message: "Detailed checker prose that must stay out of the UI",
				reason: "day-only-on-device",
				instant,
			});
		expect(dayOnly({ comparison: "ordering", property: "date_opened" })).toBe(
			"A device keeps only the day a case was opened. You can compare it with a date instead",
		);
		expect(dayOnly({ comparison: "equality", property: "last_modified" })).toBe(
			"A device keeps only the day a case was last changed, so it never matches a moment. You can compare it with a date, or check a range of days",
		);
	});

	it("keeps the general line for values that don't line up with no reason", () => {
		expect(present("incompatible-values")).toBe(
			"Choose values that use compatible kinds of information",
		);
	});

	it.each([
		[
			"many-values",
			"This needs one value. You can read one entry, or count or join them",
		],
		[
			"datetime-literal-precision",
			"CommCare compares times to the millisecond. You can choose a time to the millisecond, second or minute",
		],
		[
			"format-date-pattern-not-fixed",
			"This date format can't change from row to row here. You can choose a fixed format",
		],
	] as const)("presents %s", (code, copy) => {
		expect(present(code)).toBe(copy);
	});
});
