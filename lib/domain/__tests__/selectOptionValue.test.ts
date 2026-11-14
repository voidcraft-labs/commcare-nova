import { describe, expect, it } from "vitest";
import {
	duplicateSelectOptionValues,
	isValidSelectOptionValue,
	repairSelectOptionValue,
	SELECT_OPTION_VALUE_PATTERN,
	sanitizeSelectOptionValue,
	selectOptionValueProblem,
	selectOptionValueProblemAmong,
	selectOptionValueSchema,
	suggestSelectOptionValue,
} from "../selectOptionValue";

describe("selectOptionValueSchema", () => {
	it.each([
		["", false],
		[" ", false],
		["a b", false],
		["a'b", true],
		['a"b', true],
		["a`b", true],
		["it's", true],
		[`a'b"c`, false],
		["ok", true],
		["sí", true],
		["a-b.c", true],
		["a\u00a0b", false],
		["a\u2028b", false],
		["instance('abc')", false],
		['instance("item-list:villages")', false],
		["instance(\u0085'a')", false],
		["instance", true],
		["instance_abc", true],
		["instance('abc", true],
	] as const)(
		"classifies %j against the same independently stated grammar",
		(value, accepted) => {
			expect(selectOptionValueSchema.safeParse(value).success).toBe(accepted);
			expect(isValidSelectOptionValue(value)).toBe(accepted);
		},
	);

	it("states in its pattern everything but the both-quotes refusal", () => {
		// The served pattern carries what every provider's engine reads; a
		// value holding both quote marks passes it and is refused beside it.
		expect(SELECT_OPTION_VALUE_PATTERN.test(`a'b"c`)).toBe(true);
		const refused = selectOptionValueSchema.safeParse(`a'b"c`);
		expect(refused.success).toBe(false);
		expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
			"Nova can't yet write a rule that names a choice holding both an apostrophe and a double quote. Keeping one kind of quote mark, or neither, works.",
		]);
		expect(SELECT_OPTION_VALUE_PATTERN.test("a b")).toBe(false);
		expect(SELECT_OPTION_VALUE_PATTERN.test("")).toBe(false);
	});

	it("refuses beside its pattern a value CommCare HQ's build reads as a data source", () => {
		expect(SELECT_OPTION_VALUE_PATTERN.test("instance('abc')")).toBe(true);
		const refused = selectOptionValueSchema.safeParse("instance('abc')");
		expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
			"CommCare HQ reads a choice value written like instance('…') as a data source when it builds the form, so the app couldn't be built as written. A value without the brackets and quote marks, such as instance_abc, works.",
		]);
	});
});

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

	it("names an empty value, whitespace, or both quote marks in one value", () => {
		expect(selectOptionValueProblem("")).toBe("empty");
		expect(selectOptionValueProblem("Prefer not to say")).toBe("whitespace");
		expect(selectOptionValueProblem("tab\there")).toBe("whitespace");
		expect(selectOptionValueProblem("line\nbreak")).toBe("whitespace");
		expect(selectOptionValueProblem('say "hi"')).toBe("whitespace");
		expect(selectOptionValueProblem(" ")).toBe("whitespace");
		expect(selectOptionValueProblem(`a'b"c`)).toBe("both-quotes");
		expect(selectOptionValueProblem("instance('casedb')")).toBe(
			"instance-read",
		);
		expect(
			repairSelectOptionValue(
				"instance('casedb')",
				"Cases",
				"option_1",
				new Set(),
			),
		).toBe("instance_casedb");
	});

	it("admits a value holding one kind of quote mark", () => {
		for (const value of ["it's", 'a"b', "a`b", "`tick`", "don't"]) {
			expect(selectOptionValueProblem(value)).toBeUndefined();
		}
	});
});

describe("sanitizeSelectOptionValue", () => {
	it("joins whitespace runs with one underscore and keeps quote marks", () => {
		expect(sanitizeSelectOptionValue("Prefer not   to say")).toBe(
			"Prefer_not_to_say",
		);
		expect(sanitizeSelectOptionValue("don't know")).toBe("don't_know");
		expect(sanitizeSelectOptionValue(' "quoted" ')).toBe('_"quoted"_');
		expect(sanitizeSelectOptionValue("it's")).toBe("it's");
		expect(sanitizeSelectOptionValue("a`b")).toBe("a`b");
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

	it("returns the empty string only for an empty box", () => {
		expect(sanitizeSelectOptionValue("")).toBe("");
		expect(sanitizeSelectOptionValue("''")).toBe("''");
		expect(sanitizeSelectOptionValue("   ")).toBe("_");
	});

	it("sanitizes whitespace and quote examples into admitted values or empty", () => {
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

describe("duplicate values in one list", () => {
	it("keeps the first holder and offers each later one a free value", () => {
		expect(
			duplicateSelectOptionValues(["yes", "no", "yes", "yes_2", "yes", "no"]),
		).toEqual([
			{ index: 2, value: "yes", suggestion: "yes_3" },
			{ index: 4, value: "yes", suggestion: "yes_4" },
			{ index: 5, value: "no", suggestion: "no_2" },
		]);
	});

	it("compares exactly and leaves a grammar problem to its own refusal", () => {
		expect(duplicateSelectOptionValues(["yes", "Yes", "a b", "a b"])).toEqual(
			[],
		);
	});

	it("judges a value among the values before it", () => {
		expect(selectOptionValueProblemAmong("yes", new Set(["yes"]))).toBe(
			"duplicate",
		);
		expect(selectOptionValueProblemAmong("a b", new Set(["a b"]))).toBe(
			"whitespace",
		);
		expect(selectOptionValueProblemAmong("Yes", new Set(["yes"]))).toBe(
			undefined,
		);
	});
});
