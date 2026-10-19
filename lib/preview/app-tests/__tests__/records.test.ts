// An app test reads a module with a Search action the way each read stands
// for: its browse list is the session's device, its Results are the search.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	recordsReadSearch,
	searchedReading,
} from "../../engine/serverSearchRead";

const WITH_SEARCH = {
	caseListConfig: resolveCaseListConfig({
		columns: [],
		searchInputs: [
			simpleSearchInputDef(
				testUuid("name-input"),
				"name",
				"Name",
				"text",
				"case_name",
			),
		],
	}),
};

it.each([
	["its browse list", {}, { filter: "casedb", columns: "casedb" }],
	[
		"its search's Results",
		{ searchAnswers: [] },
		{ filter: "search", columns: "results" },
	],
	[
		"the case its no-matches form registered",
		{ registeredCaseId: "case-1" },
		{ filter: "search", columns: "results" },
	],
] as const)("reads %s by that read's reading", (_read, screen, reading) => {
	expect(searchedReading(recordsReadSearch(WITH_SEARCH, screen))).toEqual(
		reading,
	);
});
