import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
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
	datetimeCoerce,
	double,
	eq,
	gt,
	gte,
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
} from "@/lib/domain/expression";
import { evaluateAsync } from "../../xpath/asyncEvaluator";
import { toBoolean } from "../../xpath/coerce";
import type { PreviewSearchSessionValues } from "../identity";
import type { SearchScreenXPath } from "../searchExpressionEvaluation";
import {
	searchFindsNothing,
	searchInputRuntimeGlobalError,
	searchInputRuntimeQuoteErrors,
	searchInputSubmissionErrors,
	searchInputSubmissionErrorsOnDevice,
} from "../searchInputValidation";

/** The worker's side of the device path: the printed text over the
 * instances it was sent with, through the real async evaluator. */
async function evaluateOnWorker(xpath: SearchScreenXPath): Promise<boolean> {
	return toBoolean(
		await evaluateAsync(xpath.source, {
			contextPath: "",
			position: 1,
			getValue: () => undefined,
			resolveXPathInstance: (instanceId) => xpath.instances.get(instanceId),
		}),
	);
}

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
				undefined,
				validationEnvironment(config),
			).get("query"),
		).toContain("quotation mark");
		for (const accepted of ["O'Brien", 'She said "hello"', "plain text"]) {
			expect(
				searchInputRuntimeQuoteErrors(
					config,
					"patient",
					new Map([["query", accepted]]),
					undefined,
					validationEnvironment(config),
				).size,
				accepted,
			).toBe(0);
		}
	});

	it("keeps JS replacement metacharacters in a typed value inert", () => {
		// Worker-entered replacement metacharacters are ordinary search bytes.
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
				undefined,
				validationEnvironment(config),
			).get("query"),
		).toContain("quotation mark");
		for (const accepted of ["$&", "$$", "pay $& now"]) {
			expect(
				searchInputRuntimeQuoteErrors(
					config,
					"patient",
					new Map([["query", accepted]]),
					undefined,
					validationEnvironment(config),
				).size,
				accepted,
			).toBe(0);
		}
	});

	it.each([
		"instance('commcaresession')/session/context/username",
		"instance('search-input:results')/input/field[@name='second']",
	])("keeps XPath-looking prompt bytes inert: %s", (value) => {
		const config = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					FIRST,
					"first",
					"First",
					"text",
					whenInput(
						input(FIRST),
						eq(prop("patient", "case_name"), input(FIRST)),
					),
				),
				advancedSearchInputDef(SECOND, "second", "Second", "text", matchAll()),
			],
		});
		const session = {
			context: { username: 'The "Boss"' },
			user: {},
			userPropertySlugs: {},
		};
		expect([
			...searchInputRuntimeQuoteErrors(
				config,
				"patient",
				new Map([
					["first", value],
					["second", 'The "Boss"'],
				]),
				session,
				validationEnvironment(config),
			),
		]).toEqual([]);
		expect(
			searchInputRuntimeQuoteErrors(
				config,
				"patient",
				new Map([
					["first", `${value} "quoted"`],
					["second", "plain"],
				]),
				session,
				validationEnvironment(config),
			).get("first"),
		).toContain("quotation mark");
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
			undefined,
			validationEnvironment(config),
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
				undefined,
				validationEnvironment(config),
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
			validationEnvironment(config),
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
				undefined,
				validationEnvironment(config),
			).get("months"),
		).toContain("whole number");
		expect(
			searchInputSubmissionErrors(
				config,
				"patient",
				new Map([["months", "2"]]),
				undefined,
				validationEnvironment(config),
			).size,
		).toBe(0);
		expect(
			searchInputSubmissionErrors(
				config,
				"patient",
				new Map([["months", ""]]),
				undefined,
				validationEnvironment(config),
			).size,
		).toBe(0);
	});

	it("rejects negative or fractional prompted child-count bounds", () => {
		const predicate = whenInput(
			input(FIRST),
			gt(count(subcasePath("parent", "child")), double(term(input(FIRST)))),
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
					undefined,
					validationEnvironment(config),
				).get("minimum"),
			).toContain("zero or greater");
		}
		for (const valid of ["0", "-0", "-0.0", "1.0"]) {
			expect(
				searchInputSubmissionErrors(
					config,
					"patient",
					new Map([["minimum", valid]]),
					undefined,
					validationEnvironment(config),
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
			undefined,
			validationEnvironment(config),
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
					undefined,
					validationEnvironment(config),
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
					undefined,
					validationEnvironment(config),
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
				undefined,
				validationEnvironment(config),
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
			searchInputRuntimeGlobalError(
				config,
				"patient",
				new Map(),
				{
					context: {},
					user: { search_label: `O'Brien "Clinic"` },
					userPropertySlugs: {},
				},
				validationEnvironment(config),
			),
		).toContain("quotation marks");
		expect(
			searchInputRuntimeGlobalError(
				config,
				"patient",
				new Map(),
				{
					context: {},
					user: { search_label: "O'Brien Clinic" },
					userPropertySlugs: {},
				},
				validationEnvironment(config),
			),
		).toBeUndefined();

		const inherited = Object.create({
			search_label: `O'Brien "Clinic"`,
		}) as Record<string, string>;
		expect(
			searchInputRuntimeGlobalError(
				config,
				"patient",
				new Map(),
				{
					context: {},
					user: inherited,
					userPropertySlugs: {},
				},
				validationEnvironment(config),
			),
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
			searchInputRuntimeGlobalError(
				config,
				"patient",
				new Map(),
				{
					context: {},
					user: { default_location: "not a location" },
					userPropertySlugs: {},
				},
				validationEnvironment(config),
			),
		).toContain("latitude and longitude");
		expect(
			searchInputRuntimeGlobalError(
				config,
				"patient",
				new Map(),
				{
					context: {},
					user: { default_location: "42.3601 -71.0589" },
					userPropertySlugs: {},
				},
				validationEnvironment(config),
			),
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
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map(),
			undefined,
			validationEnvironment(config),
		);
		expect(errors.get("full_name")).toBe(SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE);
		expect(errors.get("phone")).toBe("Give a name or a phone number.");
	});

	it("judges a sibling-answered condition from the submitted values", () => {
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([["full_name", "Asha"]]),
			undefined,
			validationEnvironment(config),
		);
		expect(errors.has("phone")).toBe(false);
		expect(errors.has("full_name")).toBe(false);
	});

	it("skips a check on a blank answer", () => {
		const errors = searchInputSubmissionErrors(
			config,
			"patient",
			new Map([["full_name", "Asha"]]),
			undefined,
			validationEnvironment(config),
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
			undefined,
			validationEnvironment(config),
		);
		expect(errors.has("email")).toBe(false);
	});

	it("judges the pattern-bearing check with the real async XPath evaluator", async () => {
		const sources: string[] = [];
		const errors = await searchInputSubmissionErrorsOnDevice(
			config,
			"patient",
			new Map([
				["full_name", "Asha"],
				["email", "not-an-address"],
			]),
			undefined,
			validationEnvironment(config),
			{
				evaluateOnDevice: async (xpath) => {
					sources.push(xpath.source);
					return evaluateOnWorker(xpath);
				},
			},
		);
		expect(errors.get("email")).toBe("Enter an email address.");
		expect(sources).toEqual([
			"regex(if(count(instance('search-input:results')/input/field) > 0, instance('search-input:results')/input/field[@name = 'email'], ''), '@')",
		]);
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
			validationEnvironment(config),
			{
				evaluateOnDevice: evaluateOnWorker,
			},
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
			validationEnvironment(config),
			{
				evaluateOnDevice: async () => {
					devicePasses += 1;
					return true;
				},
			},
		);
		expect(devicePasses).toBe(0);
		expect(onDevice).toEqual(
			searchInputSubmissionErrors(
				config,
				"patient",
				new Map(),
				undefined,
				validationEnvironment(config),
			),
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
			searchInputRuntimeQuoteErrors(
				quoted,
				"patient",
				value,
				undefined,
				validationEnvironment(quoted),
			).get("query"),
		).toContain("quotation mark");
		expect(
			searchInputSubmissionErrors(
				quoted,
				"patient",
				value,
				undefined,
				validationEnvironment(quoted),
			).get("query"),
		).toBe("Leave the query blank.");
	});
});

describe("searchFindsNothing", () => {
	const config: CaseListConfig = resolveCaseListConfig({
		columns: [],
		searchInputs: [],
		filter: gte(
			prop("patient", "date_opened"),
			datetimeCoerce(term(sessionUser("visit_day"))),
		),
	});
	const session = (
		visitDay: string | undefined,
	): PreviewSearchSessionValues => ({
		context: {},
		user: visitDay === undefined ? {} : { visit_day: visitDay },
		userPropertySlugs: {},
	});

	it("finds nothing, with no message, while a session value compared with date_opened is blank", () => {
		for (const blank of [undefined, ""]) {
			expect(
				searchFindsNothing(
					config,
					"patient",
					new Map(),
					session(blank),
					validationEnvironment(config),
				),
			).toBe(true);
			expect(
				searchInputRuntimeGlobalError(
					config,
					"patient",
					new Map(),
					session(blank),
					validationEnvironment(config),
				),
			).toBeUndefined();
		}
	});

	it("searches once the value holds a date", () => {
		expect(
			searchFindsNothing(
				config,
				"patient",
				new Map(),
				session("2026-01-01"),
				validationEnvironment(config),
			),
		).toBe(false);
	});
});

function validationEnvironment(config: CaseListConfig) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "label", label: "Label", data_type: "text" },
					{ name: "due_date", label: "Due date", data_type: "date" },
					{ name: "home_location", label: "Home location", data_type: "text" },
					{ name: "work_location", label: "Work location", data_type: "text" },
					{ name: "location", label: "Location", data_type: "text" },
					{ name: "full_name", label: "Full name", data_type: "text" },
					{ name: "phone", label: "Phone", data_type: "text" },
					{ name: "email", label: "Email", data_type: "text" },
				],
			},
			{
				name: "child",
				parent_type: "patient",
				properties: [],
			},
		],
		modules: [
			{ name: "Patients", caseType: "patient", caseListConfig: config },
		],
	});
	return { doc, moduleUuid: doc.moduleOrder[0] };
}
