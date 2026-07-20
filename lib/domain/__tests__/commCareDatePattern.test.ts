import { describe, expect, it } from "vitest";
import {
	COMMCARE_DATE_FORMAT_TOKENS,
	isSupportedCommCareDatePattern,
	parseCommCareDatePattern,
} from "../commCareDatePattern";

describe("CommCare date-pattern vocabulary", () => {
	it("parses every escape implemented by JavaRosa DateUtils", () => {
		const pattern = COMMCARE_DATE_FORMAT_TOKENS.map(
			(token) => `%${token}`,
		).join("|");
		const result = parseCommCareDatePattern(pattern);
		expect(result.kind).toBe("parsed");
		expect(isSupportedCommCareDatePattern(pattern)).toBe(true);
	});

	it.each(["%Q", "Date %"])(
		"rejects the unsupported pattern %s without partial interpretation",
		(pattern) => {
			expect(parseCommCareDatePattern(pattern).kind).toBe(
				"unsupported-pattern",
			);
			expect(isSupportedCommCareDatePattern(pattern)).toBe(false);
		},
	);
});
