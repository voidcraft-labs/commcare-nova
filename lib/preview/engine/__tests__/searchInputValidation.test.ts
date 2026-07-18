import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseListConfig,
} from "@/lib/domain";
import {
	and,
	concat,
	count,
	dateAdd,
	double,
	eq,
	gt,
	input,
	matchAll,
	prop,
	sessionUser,
	subcasePath,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import {
	searchInputRuntimeGlobalError,
	searchInputRuntimeQuoteErrors,
	searchInputSubmissionErrors,
} from "../searchInputValidation";

const FIRST = asUuid("00000000-0000-0000-0000-0000000000a1");
const SECOND = asUuid("00000000-0000-0000-0000-0000000000a2");
const THIRD = asUuid("00000000-0000-0000-0000-0000000000a3");

function locationInput(uuid: typeof FIRST, name: string, property: string) {
	return advancedSearchInputDef(
		uuid,
		name,
		name,
		"text",
		whenInput(
			input(name),
			within(prop("patient", property), input(name), 10, "kilometers"),
		),
	);
}

describe("searchInputRuntimeQuoteErrors", () => {
	it("rejects only the direct prompt value CSQL cannot quote faithfully", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"query",
					"Query",
					"text",
					whenInput(
						input("query"),
						eq(prop("patient", "case_name"), input("query")),
					),
				),
			],
		};

		expect(
			searchInputRuntimeQuoteErrors(
				config,
				"patient",
				new Map([["query", `O'Brien said "hello"`]]),
			).get("query"),
		).toContain("quotation mark");
		for (const accepted of ["O'Brien", 'She said "hello"', "plain text"]) {
			expect(
				searchInputRuntimeQuoteErrors(
					config,
					"patient",
					new Map([["query", accepted]]),
				).size,
				accepted,
			).toBe(0);
		}
	});

	it("rejects a computed output that combines individually safe answers", () => {
		const combined = whenInput(
			input("first"),
			whenInput(
				input("second"),
				eq(
					prop("patient", "label"),
					concat(term(input("first")), term(input("second"))),
				),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "first", "First", "text", combined),
				advancedSearchInputDef(SECOND, "second", "Second", "text", matchAll()),
			],
		};

		const errors = searchInputRuntimeQuoteErrors(
			config,
			"patient",
			new Map([
				["first", "O'Brien"],
				["second", 'The "Boss"'],
			]),
		);
		expect([...errors.keys()].sort()).toEqual(["first", "second"]);
		expect(
			searchInputRuntimeQuoteErrors(
				config,
				"patient",
				new Map([
					["first", "O'Brien"],
					["second", "The Boss"],
				]),
			).size,
		).toBe(0);
	});

	it("evaluates session bytes inside the same computed rejection condition", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"query",
					"Query",
					"text",
					whenInput(
						input("query"),
						eq(
							prop("patient", "label"),
							concat(term(input("query")), term(sessionUser("nickname"))),
						),
					),
				),
			],
		};

		const errors = searchInputRuntimeQuoteErrors(
			config,
			"patient",
			new Map([["query", "O'Brien"]]),
			{ context: {}, user: { nickname: 'The "Boss"' } },
		);
		expect([...errors.keys()]).toEqual(["query"]);
	});

	it("rejects fractional calendar quantities but keeps blank prompts optional", () => {
		const predicate = whenInput(
			input("months"),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input("months")))),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "months", "Months", "text", predicate),
			],
		};

		expect(
			searchInputSubmissionErrors(
				config,
				"patient",
				new Map([["months", "1.5"]]),
			).get("months"),
		).toContain("whole number");
		expect(
			searchInputSubmissionErrors(config, "patient", new Map([["months", "2"]]))
				.size,
		).toBe(0);
		expect(
			searchInputSubmissionErrors(config, "patient", new Map([["months", ""]]))
				.size,
		).toBe(0);
	});

	it("rejects negative or fractional prompted child-count bounds", () => {
		const predicate = whenInput(
			input("minimum"),
			gt(count(subcasePath("child")), double(term(input("minimum")))),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "minimum", "Minimum", "text", predicate),
			],
		};

		for (const invalid of ["-1", "+1", "1e3", "1.5", "not a number"]) {
			expect(
				searchInputSubmissionErrors(
					config,
					"patient",
					new Map([["minimum", invalid]]),
				).get("minimum"),
			).toContain("zero or greater");
		}
		for (const valid of ["0", "-0", "-0.0", "1.0"]) {
			expect(
				searchInputSubmissionErrors(
					config,
					"patient",
					new Map([["minimum", valid]]),
				).size,
			).toBe(0);
		}
	});

	it("keeps two independent location prompts' errors independent", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				locationInput(FIRST, "near_home", "home_location"),
				locationInput(SECOND, "near_work", "work_location"),
			],
		};

		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([
				["near_home", "not a location"],
				["near_work", "42.3601 -71.0589"],
			]),
		);
		expect([...errors.keys()]).toEqual(["near_home"]);
		expect(errors.get("near_home")).toContain("latitude and longitude");
	});

	it("accepts Nova's intentional location forms", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [locationInput(FIRST, "nearby", "location")],
		};

		for (const value of [
			"42.3601 -71.0589",
			"42.3601, -71.0589",
			"  42.3601\t-71.0589  ",
			"42.3601 -71.0589 NaN NaN",
		]) {
			expect(
				searchInputSubmissionErrors(
					config,
					"patient",
					new Map([["nearby", value]]),
				),
				value,
			).toEqual(new Map());
		}
	});

	it("rejects malformed, ambiguous, and target-incompatible locations", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [locationInput(FIRST, "nearby", "location")],
		};

		for (const value of [
			"42",
			"42 -71 0",
			"42 -71 0 1 2",
			"91 0",
			"0 181",
			"+42 -71",
			"4.2e1 -71",
			"40,7 -74,0",
			"42\u00a0-71",
		]) {
			expect(
				searchInputSubmissionErrors(
					config,
					"patient",
					new Map([["nearby", value]]),
				).get("nearby"),
				value,
			).toContain("latitude and longitude");
		}
	});

	it("does not let an inactive numeric branch blame an unrelated location", () => {
		const numeric = whenInput(
			input("enable_months"),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input("months")))),
			),
		);
		const location = whenInput(
			input("nearby"),
			within(prop("patient", "location"), input("nearby"), 10, "kilometers"),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"enable_months",
					"Enable months",
					"text",
					and(numeric, location),
				),
				advancedSearchInputDef(SECOND, "months", "Months", "text", matchAll()),
				advancedSearchInputDef(THIRD, "nearby", "Nearby", "text", matchAll()),
			],
		};

		expect(
			searchInputSubmissionErrors(
				config,
				"patient",
				new Map([
					["enable_months", ""],
					["months", "1.5"],
					["nearby", "42 -71"],
				]),
			).size,
		).toBe(0);
	});

	it("stops a promptless session quote failure before Preview reaches SQL", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [],
			filter: eq(prop("patient", "label"), term(sessionUser("search_label"))),
		};

		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { search_label: `O'Brien "Clinic"` },
			}),
		).toContain("quotation marks");
		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { search_label: "O'Brien Clinic" },
			}),
		).toBeUndefined();
	});

	it("stops a promptless invalid session location before Preview reaches SQL", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [],
			filter: within(
				prop("patient", "location"),
				term(sessionUser("default_location")),
				10,
				"kilometers",
			),
		};

		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { default_location: "not a location" },
			}),
		).toContain("latitude and longitude");
		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { default_location: "42.3601 -71.0589" },
			}),
		).toBeUndefined();
	});
});
