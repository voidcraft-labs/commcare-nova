import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type CaseListConfig,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	simpleSearchInputDef,
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
	isBlank,
	matchAll,
	matchesPattern,
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
	searchInputSubmissionErrorsOnDevice,
} from "../searchInputValidation";

const FIRST = testUuid("00000000-0000-0000-0000-0000000000a1");
const SECOND = testUuid("00000000-0000-0000-0000-0000000000a2");
const THIRD = testUuid("00000000-0000-0000-0000-0000000000a3");

function locationInput(uuid: typeof FIRST, name: string, property: string) {
	return advancedSearchInputDef(
		uuid,
		name,
		name,
		"text",
		whenInput(
			input(uuid),
			within(prop("patient", property), input(uuid), 10, "kilometers"),
		),
	);
}

describe("searchInputRuntimeQuoteErrors", () => {
	it("rejects only the direct prompt value CSQL cannot quote faithfully", () => {
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"query",
					"Query",
					"text",
					whenInput(
						input(FIRST),
						eq(prop("patient", "case_name"), input(FIRST)),
					),
				),
			],
		});

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

	it("keeps JS replacement metacharacters in a typed value inert", () => {
		// The typed value lands in the rejection condition via
		// `String.replaceAll`; a string replacement would expand `$&` to the
		// matched instance path and collapse `$$`, so the gate would judge a
		// different value than the worker typed — `$'` (apostrophe-bearing)
		// must still flag, and quote-safe `$&`/`$$` values must stay clean.
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"query",
					"Query",
					"text",
					whenInput(
						input(FIRST),
						eq(prop("patient", "case_name"), input(FIRST)),
					),
				),
			],
		});

		expect(
			searchInputRuntimeQuoteErrors(
				config,
				"patient",
				new Map([["query", `$' O'Brien said "hello"`]]),
			).get("query"),
		).toContain("quotation mark");
		for (const accepted of ["$&", "$$", "pay $& now"]) {
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
			input(FIRST),
			whenInput(
				input(SECOND),
				eq(
					prop("patient", "label"),
					concat(term(input(FIRST)), term(input(SECOND))),
				),
			),
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "first", "First", "text", combined),
				advancedSearchInputDef(SECOND, "second", "Second", "text", matchAll()),
			],
		});

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
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"query",
					"Query",
					"text",
					whenInput(
						input(FIRST),
						eq(
							prop("patient", "label"),
							concat(term(input(FIRST)), term(sessionUser("nickname"))),
						),
					),
				),
			],
		});

		const errors = searchInputRuntimeQuoteErrors(
			config,
			"patient",
			new Map([["query", "O'Brien"]]),
			{
				context: {},
				user: { nickname: 'The "Boss"' },
				userPropertySlugs: {},
			},
		);
		expect([...errors.keys()]).toEqual(["query"]);
	});

	it("rejects fractional calendar quantities but keeps blank prompts optional", () => {
		const predicate = whenInput(
			input(FIRST),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input(FIRST)))),
			),
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "months", "Months", "text", predicate),
			],
		});

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
			input(FIRST),
			gt(count(subcasePath("child")), double(term(input(FIRST)))),
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(FIRST, "minimum", "Minimum", "text", predicate),
			],
		});

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
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				locationInput(FIRST, "near_home", "home_location"),
				locationInput(SECOND, "near_work", "work_location"),
			],
		});

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
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [locationInput(FIRST, "nearby", "location")],
		});

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
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [locationInput(FIRST, "nearby", "location")],
		});

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
			input(FIRST),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input(SECOND)))),
			),
		);
		const location = whenInput(
			input(THIRD),
			within(prop("patient", "location"), input(THIRD), 10, "kilometers"),
		);
		const config: CaseListConfig = resolveCaseListConfig({
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
		});

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
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [],
			filter: eq(prop("patient", "label"), term(sessionUser("search_label"))),
		});

		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { search_label: `O'Brien "Clinic"` },
				userPropertySlugs: {},
			}),
		).toContain("quotation marks");
		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { search_label: "O'Brien Clinic" },
				userPropertySlugs: {},
			}),
		).toBeUndefined();

		const inherited = Object.create({
			search_label: `O'Brien "Clinic"`,
		}) as Record<string, string>;
		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: inherited,
				userPropertySlugs: {},
			}),
		).toBeUndefined();
	});

	it("stops a promptless invalid session location before Preview reaches SQL", () => {
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [],
			filter: within(
				prop("patient", "location"),
				term(sessionUser("default_location")),
				10,
				"kilometers",
			),
		});

		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { default_location: "not a location" },
				userPropertySlugs: {},
			}),
		).toContain("latitude and longitude");
		expect(
			searchInputRuntimeGlobalError(config, "patient", new Map(), {
				context: {},
				user: { default_location: "42.3601 -71.0589" },
				userPropertySlugs: {},
			}),
		).toBeUndefined();
	});
});

describe("searchInputSubmissionErrors — Search screen required conditions and checks", () => {
	// The composed gate the Search screen and the server action share. The
	// constraint layer itself is covered in `searchInputConstraints.test.ts`;
	// these pin how it composes with the CSQL-derived errors on one prompt
	// and how the two gates differ only in what a Pattern engine adds.
	const NAME = testUuid("00000000-0000-0000-0000-0000000000c1");
	const PHONE = testUuid("00000000-0000-0000-0000-0000000000c2");
	const EMAIL = testUuid("00000000-0000-0000-0000-0000000000c3");

	const config: CaseListConfig = resolveCaseListConfig({
		columns: [],
		searchInputs: [
			simpleSearchInputDef(NAME, "full_name", "Name", "text", "full_name", {
				required: {},
			}),
			simpleSearchInputDef(PHONE, "phone", "Phone", "text", "phone", {
				// One of the two identifies the person.
				required: {
					when: isBlank(input(NAME)),
					message: "Give a name or a phone number.",
				},
			}),
			simpleSearchInputDef(EMAIL, "email", "Email", "text", "email", {
				validation: {
					rule: matchesPattern(input(EMAIL), "@"),
					message: "Enter an email address.",
				},
			}),
		],
	});

	it("reports a blank required prompt with its message", () => {
		const errors = searchInputSubmissionErrors(config, "patient", new Map());
		expect(errors.get("full_name")).toBe(SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE);
		expect(errors.get("phone")).toBe("Give a name or a phone number.");
	});

	it("judges a sibling-answered condition from the submitted values", () => {
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([["full_name", "Asha"]]),
		);
		expect(errors.has("phone")).toBe(false);
		expect(errors.has("full_name")).toBe(false);
	});

	it("skips a check on a blank answer", () => {
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([["full_name", "Asha"]]),
		);
		expect(errors.has("email")).toBe(false);
	});

	it("leaves a pattern-bearing check unjudged without a Pattern engine", () => {
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([
				["full_name", "Asha"],
				["email", "not-an-address"],
			]),
		);
		expect(errors.has("email")).toBe(false);
	});

	it("judges the pattern-bearing check on the device path with the answer bound in", async () => {
		const sources: string[] = [];
		const errors = await searchInputSubmissionErrorsOnDevice(
			config,
			"patient",
			new Map([
				["full_name", "Asha"],
				["email", "not-an-address"],
			]),
			undefined,
			undefined,
			{
				evaluateOnDevice: async (source) => {
					sources.push(source);
					return false;
				},
			},
		);
		expect(errors.get("email")).toBe("Enter an email address.");
		expect(sources).toEqual(["regex('not-an-address', '@')"]);
	});

	it("clears the check on the device path when the answer fits", async () => {
		const errors = await searchInputSubmissionErrorsOnDevice(
			config,
			"patient",
			new Map([
				["full_name", "Asha"],
				["email", "asha@example.org"],
			]),
			undefined,
			undefined,
			{ evaluateOnDevice: async () => true },
		);
		expect(errors.size).toBe(0);
	});

	it("decides plain constraints identically on both gates without the device", async () => {
		let devicePasses = 0;
		const onDevice = await searchInputSubmissionErrorsOnDevice(
			config,
			"patient",
			new Map(),
			undefined,
			undefined,
			{
				evaluateOnDevice: async () => {
					devicePasses += 1;
					return true;
				},
			},
		);
		expect(devicePasses).toBe(0);
		expect(onDevice).toEqual(
			searchInputSubmissionErrors(config, "patient", new Map()),
		);
	});

	it("lets an authored check message win over the CSQL quote error on one prompt", () => {
		// The worker can act on the authored sentence directly; the system
		// quote sentence describes the same answer less usefully.
		const QUERY = testUuid("00000000-0000-0000-0000-0000000000c4");
		const quoted: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					QUERY,
					"query",
					"Query",
					"text",
					whenInput(
						input(QUERY),
						eq(prop("patient", "case_name"), input(QUERY)),
					),
					{
						validation: {
							rule: isBlank(input(QUERY)),
							message: "Leave the query blank.",
						},
					},
				),
			],
		});
		const value = new Map([["query", `O'Brien said "hello"`]]);

		expect(
			searchInputRuntimeQuoteErrors(quoted, "patient", value).get("query"),
		).toContain("quotation mark");
		expect(
			searchInputSubmissionErrors(quoted, "patient", value).get("query"),
		).toBe("Leave the query blank.");
	});
});
