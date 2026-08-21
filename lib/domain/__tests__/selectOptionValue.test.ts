import { describe, expect, it } from "vitest";
import {
	isValidSelectOptionValue,
	repairSelectOptionValue,
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
		expect(sanitizeSelectOptionValue(' "quoted" ')).toBe("_quoted_");
	});

	it("keeps case and every other character, so deliberate codes survive", () => {
		expect(sanitizeSelectOptionValue("ICD10")).toBe("ICD10");
		expect(sanitizeSelectOptionValue("a-b.c")).toBe("a-b.c");
	});

	it("leaves an edge underscore alone, so typing one character at a time works", () => {
		// A controlled input re-sanitizes on every keystroke: trimming edges
		// would erase the `_` (or the space just turned into one) before the
		// next character arrives, and nobody could ever type `a_b`.
		let typed = "";
		const seen: string[] = [];
		for (const ch of "a b_c") {
			typed = sanitizeSelectOptionValue(typed + ch);
			seen.push(typed);
		}
		expect(seen).toEqual(["a", "a_", "a_b", "a_b_", "a_b_c"]);
	});

	it("returns the empty string only when nothing survives", () => {
		expect(sanitizeSelectOptionValue("")).toBe("");
		expect(sanitizeSelectOptionValue("''")).toBe("");
		expect(sanitizeSelectOptionValue("   ")).toBe("_");
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

	it("keeps letters and digits of any script, since the grammar admits them", () => {
		expect(suggestSelectOptionValue("Sí", "option_1")).toBe("sí");
		expect(suggestSelectOptionValue("はい", "option_1")).toBe("はい");
		expect(suggestSelectOptionValue("Über 5 Jahre", "option_1")).toBe(
			"über_5_jahre",
		);
		for (const value of ["sí", "はい", "über_5_jahre"]) {
			expect(isValidSelectOptionValue(value)).toBe(true);
		}
	});

	it("keeps combining marks, so abugida and tone-marked scripts stay whole", () => {
		// Vowel signs, virama, nukta, and tone marks are \p{M}, not \p{L};
		// a letters-and-digits class splits every word that uses them.
		expect(suggestSelectOptionValue("नमस्ते", "option_1")).toBe("नमस्ते");
		expect(suggestSelectOptionValue("नहीं पता", "option_1")).toBe("नहीं_पता");
		expect(suggestSelectOptionValue("বাংলা", "option_1")).toBe("বাংলা");
		expect(suggestSelectOptionValue("ไม่ทราบ", "option_1")).toBe("ไม่ทราบ");
		expect(suggestSelectOptionValue("Ẹ́kọ́", "option_1")).toBe("ẹ́kọ́");
		for (const value of ["नमस्ते", "नहीं_पता", "ไม่ทราบ", "ẹ́kọ́"]) {
			expect(isValidSelectOptionValue(value)).toBe(true);
		}
	});

	it("mints one value for a label however its accents are encoded", () => {
		const decomposed = "Sí";
		expect(decomposed).not.toBe("Sí");
		expect(suggestSelectOptionValue(decomposed, "option_1")).toBe(
			suggestSelectOptionValue("Sí", "option_1"),
		);
		expect(suggestSelectOptionValue(decomposed, "option_1")).toBe("sí");
	});

	it("never names a value a sibling already holds", () => {
		const taken = new Set(["yes", "yes_2"]);
		expect(suggestSelectOptionValue("Yes", "option_1", taken)).toBe("yes_3");
		expect(suggestSelectOptionValue("No", "option_1", taken)).toBe("no");
	});
});

describe("repairSelectOptionValue", () => {
	it("keeps the value's own words when any survive, else the label's, else the fallback", () => {
		expect(
			repairSelectOptionValue(
				"Prefer not to say",
				"Rather not",
				"option_1",
				new Set(),
			),
		).toBe("prefer_not_to_say");
		expect(
			repairSelectOptionValue("don't_know", "", "option_1", new Set()),
		).toBe("dont_know");
		expect(
			repairSelectOptionValue("", "Not applicable", "option_1", new Set()),
		).toBe("not_applicable");
		expect(repairSelectOptionValue(" ", "???", "option_4", new Set())).toBe(
			"option_4",
		);
	});

	it("steps past a sibling's value", () => {
		expect(
			repairSelectOptionValue("a b", "A b", "option_1", new Set(["a_b"])),
		).toBe("a_b_2");
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
