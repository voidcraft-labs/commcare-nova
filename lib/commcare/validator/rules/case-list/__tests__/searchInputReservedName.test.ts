import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	advancedSearchInputDef,
	hiddenSearchInputDef,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, prop, sessionUser, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const RESERVED_CODES = new Set([
	"CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER",
	"CASE_LIST_SEARCH_INPUT_NAME_RESERVED",
]);

/** The patient case type, with a property under a reserved request key so an
 * input on it reaches HQ as its own key. */
function docWithInputs(inputs: SearchInputDef[]) {
	const base = admittedCaseListDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "include_closed", label: proseText("Include closed") },
				],
			},
		],
	});
	return withSearchInputs(base, inputs);
}

function reservedFindings(inputs: SearchInputDef[]) {
	return findings(docWithInputs(inputs))
		.filter((error) => RESERVED_CODES.has(error.code))
		.map((error) => [error.code, error.details?.inputUuid]);
}

/** An own-key input: exact text, named after the property it searches. */
function ownKey(name: string) {
	return simpleSearchInputDef(
		testUuid(`own-${name}`),
		name,
		name,
		"text",
		name,
	);
}

/** The same name on an input sent with `exclude`: its comparison rides
 * `_xpath_query`, so its name is only a handle. */
function excluded(name: string) {
	return simpleSearchInputDef(
		testUuid(`excluded-${name}`),
		name,
		name,
		"text",
		"case_name",
	);
}

describe("searchInputReservedName", () => {
	it("refuses an own-key input under a reserved name, and admits the same name sent with exclude", () => {
		const refused = ownKey("include_closed");
		expect(reservedFindings([refused])).toEqual([
			["CASE_LIST_SEARCH_INPUT_NAME_RESERVED", refused.uuid],
		]);
		expect(reservedFindings([excluded("include_closed")])).toEqual([]);
	});

	it("says what the name does and asks for a rename", () => {
		const doc = docWithInputs([ownKey("include_closed")]);
		const [finding] = findings(doc).filter((error) =>
			RESERVED_CODES.has(error.code),
		);
		expect(finding?.message).toBe(
			'Search input "include_closed" in "Patients" uses a name CommCare reads as part of the search request, so it would never search a case property. Rename the input.',
		);
		expect(finding?.location.moduleUuid).toBe(doc.moduleOrder[0]);
	});

	it("refuses _xpath_query on every route", () => {
		const routes: SearchInputDef[] = [
			excluded("_xpath_query"),
			advancedSearchInputDef(
				testUuid("advanced-xpath-query"),
				"_xpath_query",
				"Advanced",
				"text",
				eq(prop("patient", "case_name"), literal("Ada")),
			),
			hiddenSearchInputDef(
				testUuid("hidden-xpath-query"),
				"_xpath_query",
				"Hidden",
				term(sessionUser("username")),
			),
		];
		for (const input of routes) {
			expect(reservedFindings([input])).toEqual([
				["CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER", input.uuid],
			]);
		}
	});

	it("admits owner_id and case_id, which HQ searches as the owner and the case", () => {
		expect(
			reservedFindings([excluded("owner_id"), excluded("case_id")]),
		).toEqual([]);
		expect(
			reservedFindings([
				simpleSearchInputDef(
					testUuid("owner"),
					"owner_id",
					"Owner",
					"text",
					"owner_id",
				),
			]),
		).toEqual([]);
	});
});
