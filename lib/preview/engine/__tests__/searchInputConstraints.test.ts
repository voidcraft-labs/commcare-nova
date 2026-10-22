import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import type { SearchInputDef } from "@/lib/domain";
import {
	hiddenSearchInputDef,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	input,
	isBlank,
	literal,
	matchesPattern,
	sessionContext,
	term,
} from "@/lib/domain/expression";
import { evaluateAsync } from "../../xpath/asyncEvaluator";
import { toBoolean } from "../../xpath/coerce";
import type { PreviewSearchSessionValues } from "../identity";
import { sessionInstancePathValue } from "../searchExpressionEvaluation";
import {
	searchInputConstraintErrors,
	searchInputConstraintErrorsOnDevice,
	searchInputRequiredMarks,
	searchInputRequiredMarksOnDevice,
} from "../searchInputConstraints";

async function evaluatePatternSource(source: string): Promise<boolean> {
	return toBoolean(
		await evaluateAsync(source, {
			contextPath: "",
			position: 1,
			getValue: (path) => sessionInstancePathValue(path, SESSION),
			resolveHashtag: () => "",
			resolveInstance: (instanceId, path) =>
				instanceId === "commcaresession"
					? {
							kind: "supported",
							value: sessionInstancePathValue(path, SESSION),
						}
					: { kind: "unsupported" },
		}),
	);
}

const NAME = testUuid("00000000-0000-0000-0000-0000000000b1");
const PHONE = testUuid("00000000-0000-0000-0000-0000000000b2");
const SSN = testUuid("00000000-0000-0000-0000-0000000000b3");

const SESSION: PreviewSearchSessionValues = {
	context: { username: "asha" },
	user: {},
	userPropertySlugs: {},
};

const name = simpleSearchInputDef(NAME, "name", "Name", "text", "case_name", {
	required: {},
});
const phone = simpleSearchInputDef(PHONE, "phone", "Phone", "text", "phone", {
	// Required only when the name is blank: one of the two identifies.
	required: { when: isBlank(input(NAME)), message: "Give a name or a phone" },
});
const ssn = simpleSearchInputDef(SSN, "ssn", "SSN", "text", "ssn", {
	validation: {
		rule: matchesPattern(input(SSN), "^[0-9]{3}-[0-9]{2}-[0-9]{4}$"),
		message: "Use the 123-45-6789 shape",
	},
});
const INPUTS = [name, phone, ssn];

describe("searchInputConstraintErrors", () => {
	it("fires an unconditional requirement on a blank answer with the authored or default message", () => {
		const errors = searchInputConstraintErrors(
			INPUTS,
			new Map(),
			SESSION,
			constraintEnvironment(INPUTS),
		);
		expect(errors.get("name")).toBe(SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE);
	});

	it("fires a conditional requirement only when its condition holds over the siblings", () => {
		expect(
			searchInputConstraintErrors(
				INPUTS,
				new Map(),
				SESSION,
				constraintEnvironment(INPUTS),
			).get("phone"),
		).toBe("Give a name or a phone");
		expect(
			searchInputConstraintErrors(
				INPUTS,
				new Map([["name", "Asha"]]),
				SESSION,
				constraintEnvironment(INPUTS),
			).has("phone"),
		).toBe(false);
	});

	it("skips the check on a blank answer and never reports two messages for one prompt", () => {
		const errors = searchInputConstraintErrors(
			INPUTS,
			new Map([["name", "Asha"]]),
			SESSION,
			constraintEnvironment(INPUTS),
		);
		expect(errors.has("ssn")).toBe(false);
		expect(errors.size).toBe(0);
	});

	it("leaves a pattern-bearing check unjudged where no Pattern engine runs", () => {
		// The scalar thread and the server hold no Java Pattern engine, so the
		// check neither fires nor clears here; the running Search screen judges
		// it in the XPath worker.
		const errors = searchInputConstraintErrors(
			INPUTS,
			new Map([
				["name", "Asha"],
				["ssn", "not-a-number"],
			]),
			SESSION,
			constraintEnvironment(INPUTS),
		);
		expect(errors.has("ssn")).toBe(false);
	});

	it("withholds a session-reading constraint on the session-independent pass", () => {
		const bySession = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				required: {
					when: eq(sessionContext("username"), literal("asha")),
					message: "Asha must give a phone",
				},
			},
		);
		expect(
			searchInputConstraintErrors(
				[bySession],
				new Map(),
				SESSION,
				constraintEnvironment([bySession]),
				{
					sessionIndependentOnly: true,
				},
			).has("phone"),
		).toBe(false);
		expect(
			searchInputConstraintErrors(
				[bySession],
				new Map(),
				SESSION,
				constraintEnvironment([bySession]),
			).get("phone"),
		).toBe("Asha must give a phone");
	});
});

describe("searchInputConstraintErrorsOnDevice", () => {
	it("judges a pattern-bearing check through the real async Java Pattern evaluator with the answers bound in", async () => {
		const sources: string[] = [];
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map([
				["name", "Asha"],
				["ssn", "12-345"],
			]),
			SESSION,
			constraintEnvironment(INPUTS),
			{
				evaluateOnDevice: async (source) => {
					sources.push(source);
					return evaluatePatternSource(source);
				},
			},
		);
		expect(errors.get("ssn")).toBe("Use the 123-45-6789 shape");
		expect(sources).toEqual([
			"regex('12-345', '^[0-9]{3}-[0-9]{2}-[0-9]{4}$')",
		]);
	});

	it("clears the check when the real Java Pattern accepts the value", async () => {
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map([
				["name", "Asha"],
				["ssn", "123-45-6789"],
			]),
			SESSION,
			constraintEnvironment(INPUTS),
			{ evaluateOnDevice: evaluatePatternSource },
		);
		expect(errors.size).toBe(0);
	});

	it("keeps plain constraints on the scalar evaluator", async () => {
		let devicePasses = 0;
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map(),
			SESSION,
			constraintEnvironment(INPUTS),
			{
				evaluateOnDevice: async () => {
					devicePasses += 1;
					return true;
				},
			},
		);
		expect(devicePasses).toBe(0);
		expect(errors.get("name")).toBe(SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE);
		expect(errors.get("phone")).toBe("Give a name or a phone");
	});
});

describe("searchInputRequiredMarks", () => {
	it("marks an unconditional requirement always and a conditional one by its verdict over the draft", () => {
		expect([
			...searchInputRequiredMarks(
				INPUTS,
				new Map(),
				SESSION,
				constraintEnvironment(INPUTS),
			),
		]).toEqual([
			["name", true],
			["phone", true],
		]);
		expect(
			searchInputRequiredMarks(
				INPUTS,
				new Map([["name", "Asha"]]),
				SESSION,
				constraintEnvironment(INPUTS),
			).get("phone"),
		).toBe(false);
	});

	it("leaves a pattern-bearing condition unjudged on the scalar thread and judges it through the real async evaluator", async () => {
		const byPattern = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				required: {
					when: matchesPattern(input(NAME), "^Dr"),
					message: "A doctor needs a phone",
				},
			},
		);
		const draft = new Map([["name", "Dr Asha"]]);
		expect(
			searchInputRequiredMarks(
				[name, byPattern],
				draft,
				SESSION,
				constraintEnvironment([name, byPattern]),
			).get("phone"),
		).toBeUndefined();
		const sources: string[] = [];
		const marks = await searchInputRequiredMarksOnDevice(
			[name, byPattern],
			draft,
			SESSION,
			constraintEnvironment([name, byPattern]),
			{
				evaluateOnDevice: async (source) => {
					sources.push(source);
					return evaluatePatternSource(source);
				},
			},
		);
		expect([...marks]).toEqual([["phone", true]]);
		expect(sources).toEqual(["regex('Dr Asha', '^Dr')"]);
	});
});

describe("hidden inputs on the Search screen", () => {
	// The device seeds every hidden prompt's value when it builds the query
	// screen, so a condition reading one judges the seeded value before the
	// worker searches, not blank.
	const SEARCH_MODE = testUuid("00000000-0000-0000-0000-0000000000b4");
	const mode = hiddenSearchInputDef(
		SEARCH_MODE,
		"search_mode",
		"Search mode",
		term(literal("strict")),
	);
	const strictPhone = simpleSearchInputDef(
		PHONE,
		"phone",
		"Phone",
		"text",
		"phone",
		{
			required: {
				when: eq(input(SEARCH_MODE), literal("strict")),
				message: "Strict searches need a phone",
			},
		},
	);

	it("judges a condition reading a hidden input against its seeded value", () => {
		expect(
			searchInputConstraintErrors(
				[mode, strictPhone],
				new Map(),
				SESSION,
				constraintEnvironment([mode, strictPhone]),
			).get("phone"),
		).toBe("Strict searches need a phone");
		expect(
			searchInputRequiredMarks(
				[mode, strictPhone],
				new Map(),
				SESSION,
				constraintEnvironment([mode, strictPhone]),
			).get("phone"),
		).toBe(true);
	});

	it("keeps a hidden value the submitted bag already carries", () => {
		expect(
			searchInputConstraintErrors(
				[mode, strictPhone],
				new Map([["search_mode", "loose"]]),
				SESSION,
				constraintEnvironment([mode, strictPhone]),
			).has("phone"),
		).toBe(false);
	});

	it("never raises a constraint for the hidden input itself", () => {
		const marks = searchInputRequiredMarks(
			[mode, strictPhone],
			new Map(),
			SESSION,
			constraintEnvironment([mode, strictPhone]),
		);
		expect(marks.has("search_mode")).toBe(false);
	});
});

function constraintEnvironment(searchInputs: readonly SearchInputDef[]) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "person",
				properties: [
					{ name: "phone", label: "Phone", data_type: "text" },
					{ name: "ssn", label: "SSN", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: {
					...caseListConfig([]),
					searchInputs: [...searchInputs],
				},
			},
		],
	});
	return { doc, moduleUuid: doc.moduleOrder[0] };
}
