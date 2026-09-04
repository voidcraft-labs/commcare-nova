import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
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
} from "@/lib/domain/predicate";
import type { PreviewSearchSessionValues } from "../identity";
import {
	searchInputConstraintErrors,
	searchInputConstraintErrorsOnDevice,
} from "../searchInputConstraints";

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
		const errors = searchInputConstraintErrors(INPUTS, new Map(), SESSION);
		expect(errors.get("name")).toBe(SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE);
	});

	it("fires a conditional requirement only when its condition holds over the siblings", () => {
		expect(
			searchInputConstraintErrors(INPUTS, new Map(), SESSION).get("phone"),
		).toBe("Give a name or a phone");
		expect(
			searchInputConstraintErrors(
				INPUTS,
				new Map([["name", "Asha"]]),
				SESSION,
			).has("phone"),
		).toBe(false);
	});

	it("skips the check on a blank answer and never reports two messages for one prompt", () => {
		const errors = searchInputConstraintErrors(
			INPUTS,
			new Map([["name", "Asha"]]),
			SESSION,
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
			searchInputConstraintErrors([bySession], new Map(), SESSION, undefined, {
				sessionIndependentOnly: true,
			}).has("phone"),
		).toBe(false);
		expect(
			searchInputConstraintErrors([bySession], new Map(), SESSION).get("phone"),
		).toBe("Asha must give a phone");
	});
});

describe("searchInputConstraintErrorsOnDevice", () => {
	it("judges a pattern-bearing check through the on-device evaluator with the answers bound in", async () => {
		const sources: string[] = [];
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map([
				["name", "Asha"],
				["ssn", "12-345"],
			]),
			SESSION,
			undefined,
			{
				evaluateOnDevice: async (source) => {
					sources.push(source);
					return false;
				},
			},
		);
		expect(errors.get("ssn")).toBe("Use the 123-45-6789 shape");
		expect(sources).toEqual([
			"regex('12-345', '^[0-9]{3}-[0-9]{2}-[0-9]{4}$')",
		]);
	});

	it("clears the check when the device evaluator answers true", async () => {
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map([
				["name", "Asha"],
				["ssn", "123-45-6789"],
			]),
			SESSION,
			undefined,
			{ evaluateOnDevice: async () => true },
		);
		expect(errors.size).toBe(0);
	});

	it("keeps plain constraints on the scalar evaluator", async () => {
		let devicePasses = 0;
		const errors = await searchInputConstraintErrorsOnDevice(
			INPUTS,
			new Map(),
			SESSION,
			undefined,
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
