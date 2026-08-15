import { describe, expect, it } from "vitest";
import { lowerXPathForJavaRosa } from "../javaRosaLowering";

describe("lowerXPathForJavaRosa", () => {
	it("lowers normalize-space to JavaRosa-native replace calls", () => {
		expect(lowerXPathForJavaRosa("normalize-space(#form/name)")).toBe(
			"replace(replace(#form/name, '[ \\t\\r\\n]+', ' '), '^ | $', '')",
		);
	});

	it("lowers nested calls without overlapping edits", () => {
		expect(
			lowerXPathForJavaRosa("normalize-space(normalize-space('  a  '))"),
		).toBe(
			"replace(replace(replace(replace('  a  ', '[ \\t\\r\\n]+', ' '), '^ | $', ''), '[ \\t\\r\\n]+', ' '), '^ | $', '')",
		);
	});

	it("preserves surrounding source bytes", () => {
		expect(lowerXPathForJavaRosa("  normalize-space(' a ')  ")).toBe(
			"  replace(replace(' a ', '[ \\t\\r\\n]+', ' '), '^ | $', '')  ",
		);
	});

	it("does not activate the experimental date transform", () => {
		expect(lowerXPathForJavaRosa("today() + 1")).toBe("today() + 1");
	});

	it("leaves invalid input for the validator", () => {
		expect(lowerXPathForJavaRosa("normalize-space(")).toBe("normalize-space(");
	});
});
