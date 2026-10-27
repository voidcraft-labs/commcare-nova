// An app test reads a module with a Search action the way each read stands
// for: its browse list is the session's device, its Results are the search.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { chosenCase } from "@/lib/commcare/__tests__/csqlCompositionFixture";
import { advancedSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	eq,
	ifExpr,
	input,
	literal,
	matchesPattern,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { previewAsMe } from "../../engine/identity";
import { SEARCH_CSQL_UNEVALUATED_MESSAGE } from "../../engine/searchCsqlRuntime";
import {
	recordsReadSearch,
	searchedReading,
	serverRecordsRead,
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

// A search row this server can't work out (a pattern the author wrote, which
// only the browser's XPath worker runs) answers the refusal the browser's
// Results read gives, never a read that reaches the compiler.
it("refuses a search whose row the server can't work out, as the browser does", async () => {
	const doc = chosenCase.doc();
	const moduleUuid = Object.values(doc.modules).find(
		(mod) => mod.name === "Members by household",
	)?.uuid;
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (moduleUuid === undefined || mod?.caseListConfig === undefined)
		throw new Error("The scenario has a members search.");
	const mode = testUuid("records-mode");
	mod.caseListConfig.searchInputs = [
		simpleSearchInputDef(mode, "mode", "Mode", "text", "case_name"),
		advancedSearchInputDef(
			testUuid("records-rule"),
			"rule",
			"Rule",
			"text",
			ifExpr(
				matchesPattern(term(input(mode)), "[a-z]+"),
				eq(prop("member", "case_name"), term(literal("Ada"))),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
		),
	];
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (identity === null) throw new Error("The fixture has no worker.");
	const outcome = await serverRecordsRead(
		{
			device: webAppsDevice(),
			doc: { ...doc, caseTypes: doc.caseTypes ?? [] },
			language: "eng",
			appId: "app",
			identity,
			deviceCases: { rows: [], indices: [] },
			lookup: { projectRevision: "1", definitions: [], rowsByTable: new Map() },
			caseTypeSchemas: undefined,
			timeZone: "UTC",
			restoreScope: { ownerIds: [] },
			// The household the members search reads under.
			selections: Object.fromEntries(
				Object.values(doc.modules)
					.filter((menu) => menu.name === "Households")
					.map((menu) => [
						menu.uuid,
						{
							caseType: "household",
							cases: [{ caseId: "household-1", caseName: "North" }],
						},
					]),
			),
		},
		{ moduleUuid, answers: [{ name: "mode", value: "abc" }] },
		(reason) => new Error(`The members search refused: ${reason}.`),
	);
	expect(outcome).toMatchObject({
		read: undefined,
		refusal: SEARCH_CSQL_UNEVALUATED_MESSAGE,
	});
});
