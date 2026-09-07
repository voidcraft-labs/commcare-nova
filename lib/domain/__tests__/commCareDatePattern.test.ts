import { describe, expect, it } from "vitest";
import {
	isSupportedCommCareDatePattern,
	parseCommCareDatePattern,
} from "../commCareDatePattern";

/** Nova's parser grammar; native JavaRosa tests own formatting compatibility. */
describe("CommCare date-pattern parsing", () => {
	it("separates literal runs, escapes and adjacent tokens without losing text", () => {
		expect(parseCommCareDatePattern("Date %Y-%m-%d %% %H%M%S.%3")).toEqual({
			kind: "parsed",
			segments: [
				{ kind: "literal", text: "Date " },
				{ kind: "token", token: "Y" },
				{ kind: "literal", text: "-" },
				{ kind: "token", token: "m" },
				{ kind: "literal", text: "-" },
				{ kind: "token", token: "d" },
				{ kind: "literal", text: " " },
				{ kind: "token", token: "%" },
				{ kind: "literal", text: " " },
				{ kind: "token", token: "H" },
				{ kind: "token", token: "M" },
				{ kind: "token", token: "S" },
				{ kind: "literal", text: "." },
				{ kind: "token", token: "3" },
			],
		});
	});
	it.each(["", "literal\n日付", "%y %n %B %b %e %h %A %a %w %Z", "%%%Y"])(
		"accepts %s consistently in parser and schema regex",
		(pattern) => {
			expect(parseCommCareDatePattern(pattern).kind).toBe("parsed");
			expect(isSupportedCommCareDatePattern(pattern)).toBe(true);
		},
	);
	it.each([
		["%Q", { kind: "unsupported-pattern", index: 0, escape: "%Q" }],
		["Date %", { kind: "unsupported-pattern", index: 5 }],
		["%Y/%q", { kind: "unsupported-pattern", index: 3, escape: "%q" }],
	])(
		"refuses %s at the first unsupported escape without a partial parse",
		(pattern, failure) => {
			expect(parseCommCareDatePattern(pattern)).toEqual(failure);
			expect(isSupportedCommCareDatePattern(pattern)).toBe(false);
		},
	);
});
