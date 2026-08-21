import { describe, expect, it } from "vitest";
import {
	isValidSelectOptionValue,
	SELECT_OPTION_VALUE_DESCRIPTION,
	SELECT_OPTION_VALUE_PATTERN,
	SELECT_OPTION_VALUE_REJECTION,
	sanitizeSelectOptionValue,
	selectOptionValueProblem,
	suggestSelectOptionValue,
} from "../selectOptionValue";

describe("selectOptionValueProblem", () => {
	it("admits the slug Nova teaches and the safe codes it does not mint", () => {
		for (const value of [
			"yes",
			"prefer_not_to_say",
			"under_5",
			"ICD10",
			"a-b",
			"x.y",
			"1",
		]) {
			expect(selectOptionValueProblem(value)).toBeUndefined();
			expect(isValidSelectOptionValue(value)).toBe(true);
			expect(SELECT_OPTION_VALUE_PATTERN.test(value)).toBe(true);
		}
	});

	it("names the first thing wrong: empty, then whitespace, then a quote", () => {
		expect(selectOptionValueProblem("")).toBe("empty");
		expect(selectOptionValueProblem("Prefer not to say")).toBe("whitespace");
		expect(selectOptionValueProblem("tab\there")).toBe("whitespace");
		expect(selectOptionValueProblem("line\nbreak")).toBe("whitespace");
		expect(selectOptionValueProblem("don't")).toBe("quote");
		expect(selectOptionValueProblem('say "hi"')).toBe("whitespace");
		expect(selectOptionValueProblem("`tick`")).toBe("quote");
		expect(selectOptionValueProblem(" ")).toBe("whitespace");
	});

	it("agrees with the anchored pattern the schemas carry", () => {
		for (const value of ["", " ", "a b", "a'b", 'a"b', "a`b", "ok", "ok_2"]) {
			expect(SELECT_OPTION_VALUE_PATTERN.test(value)).toBe(
				selectOptionValueProblem(value) === undefined,
			);
		}
	});
});

describe("sanitizeSelectOptionValue", () => {
	it("joins whitespace runs with one underscore and drops quote marks", () => {
		expect(sanitizeSelectOptionValue("Prefer not   to say")).toBe(
			"Prefer_not_to_say",
		);
		expect(sanitizeSelectOptionValue("don't know")).toBe("dont_know");
		expect(sanitizeSelectOptionValue(' "quoted" ')).toBe("quoted");
	});

	it("keeps case and every other character, so deliberate codes survive", () => {
		expect(sanitizeSelectOptionValue("ICD10")).toBe("ICD10");
		expect(sanitizeSelectOptionValue("a-b.c")).toBe("a-b.c");
	});

	it("returns the empty string when nothing survives", () => {
		expect(sanitizeSelectOptionValue("   ")).toBe("");
		expect(sanitizeSelectOptionValue("''")).toBe("");
	});

	it("always lands inside the grammar or on empty", () => {
		for (const raw of ["a b", "x' y", " lead", "trail ", "mid\tdle", "ok"]) {
			const out = sanitizeSelectOptionValue(raw);
			expect(out === "" || isValidSelectOptionValue(out)).toBe(true);
		}
	});
});

describe("suggestSelectOptionValue", () => {
	it("mints the underscore-joined slug from a label", () => {
		expect(suggestSelectOptionValue("Prefer not to say", "option_3")).toBe(
			"prefer_not_to_say",
		);
		expect(suggestSelectOptionValue("Under 5", "option_1")).toBe("under_5");
	});

	it("falls back when the label has nothing to keep", () => {
		expect(suggestSelectOptionValue("", "option_2")).toBe("option_2");
		expect(suggestSelectOptionValue("???", "option_2")).toBe("option_2");
	});
});

describe("the model-facing sentences", () => {
	it("teach the slug shape and name the two things a value cannot hold", () => {
		for (const sentence of [
			SELECT_OPTION_VALUE_DESCRIPTION,
			SELECT_OPTION_VALUE_REJECTION,
		]) {
			expect(sentence).toContain("underscores");
			expect(sentence).toContain("prefer_not_to_say");
			expect(sentence).toMatch(/spaces/);
			expect(sentence).toMatch(/quotes/);
			expect(sentence).toContain("label");
			// Nova voice: no em dashes.
			expect(sentence).not.toContain("—");
		}
	});
});
