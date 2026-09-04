/**
 * Tests for the `searchInputScreenPredicateTypeCheck` rule: the slots
 * CommCare's query screen evaluates on the device before any case exists
 * (a prompt's required condition, its check, a hidden prompt's value) and
 * the row-scoped choice filter. One invariant per `it(...)`.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	hiddenSearchInputDef,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	gt,
	input,
	isBlank,
	literal,
	matchesPattern,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import type { ValidationErrorCode } from "../../../errors";
import { runValidation } from "../../../runner";

const NAME = testUuid("si-name");
const PHONE = testUuid("si-phone");

function docWith(searchInputs: readonly SearchInputDef[]) {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
					listColumnOrder: [testUuid("col-name")],
					detailColumnOrder: [testUuid("col-name")],
					searchInputs: [...searchInputs],
				},
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "integer" },
				],
			},
		],
	});
}

function codes(
	searchInputs: readonly SearchInputDef[],
): readonly ValidationErrorCode[] {
	return runValidation(docWith(searchInputs), LOOKUP_CONTEXT_UNAVAILABLE).map(
		(e) => e.code,
	);
}

const nameInput = simpleSearchInputDef(
	NAME,
	"name",
	"Name",
	"text",
	"case_name",
);

describe("searchInputScreenPredicateTypeCheck", () => {
	it("accepts a required condition that reads a sibling answer and a check on the answer itself", () => {
		const phone = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				required: { when: isBlank(input(NAME)) },
				validation: {
					rule: matchesPattern(input(PHONE), "^[0-9]{10}$"),
					message: "Ten digits",
				},
			},
		);
		expect(
			codes([nameInput, phone]).filter((code) =>
				code.startsWith("CASE_LIST_SEARCH_INPUT_"),
			),
		).toEqual([]);
	});

	it("admits a pattern match in the required condition and the check, and nowhere else on the module", () => {
		const phone = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				required: {
					when: matchesPattern(input(NAME), "^Dr\\."),
					message: "Doctors need a phone",
				},
			},
		);
		expect(codes([nameInput, phone])).not.toContain(
			"CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_TYPE_ERROR",
		);
	});

	it("refuses a case read in a required condition: there is no case on the Search screen", () => {
		const phone = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				required: { when: eq(prop("patient", "age"), literal(0)) },
			},
		);
		const hits = runValidation(
			docWith([nameInput, phone]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter(
			(e) =>
				e.code ===
				"CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"phone"');
		expect(hits[0].message).toContain("before any case is selected");
	});

	it("refuses a case read in a check", () => {
		const phone = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				validation: {
					rule: eq(input(PHONE), prop("patient", "phone")),
					message: "Must match the case",
				},
			},
		);
		expect(codes([nameInput, phone])).toContain(
			"CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_CASE_DATA_UNAVAILABLE",
		);
	});

	it("type-checks a check against the checker's rules and names the operand path", () => {
		// `gt` over a text answer: strings are not ordered.
		const phone = simpleSearchInputDef(
			PHONE,
			"phone",
			"Phone",
			"text",
			"phone",
			{
				validation: {
					rule: gt(input(PHONE), literal("5")),
					message: "Bigger than five",
				},
			},
		);
		const hits = runValidation(
			docWith([nameInput, phone]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_TYPE_ERROR",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"phone"');
		expect(hits[0].message).toContain("doesn't type-check");
	});

	it("accepts a hidden value built from session data and refuses one that reads a case", () => {
		const stamp = hiddenSearchInputDef(
			testUuid("si-stamp"),
			"searched_by",
			"Searched by",
			term(sessionContext("username")),
		);
		expect(
			codes([nameInput, stamp]).filter((code) =>
				code.startsWith("CASE_LIST_SEARCH_INPUT_HIDDEN"),
			),
		).toEqual([]);

		const fromCase = hiddenSearchInputDef(
			testUuid("si-from-case"),
			"case_phone",
			"Case phone",
			term(prop("patient", "phone")),
		);
		expect(codes([nameInput, fromCase])).toContain(
			"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE",
		);
	});
});
