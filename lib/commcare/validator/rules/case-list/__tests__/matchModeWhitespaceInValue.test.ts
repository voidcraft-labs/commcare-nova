// Nova's whitespace diagnostics on CSQL-backed advanced search predicates.
// This suite does not run HQ/Elasticsearch. Accepted neighbors also pass the
// complete document admission gate, so a silent unrelated rule cannot stand
// in for executable authoring support.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { advancedSearchInputDef, proseText } from "@/lib/domain";
import {
	literal,
	match,
	multiSelectAll,
	multiSelectAny,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const CODE = "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE";
function candidate(predicate: Predicate) {
	return withSearchInputs(
		admittedCaseListDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select",
							options: [
								{ value: "Alice", label: proseText("Alice") },
								{ value: "Bob", label: proseText("Bob") },
							],
						},
					],
				},
			],
		}),
		[
			advancedSearchInputDef(
				testUuid("whitespace-search"),
				"search",
				"Search",
				"text",
				predicate,
			),
		],
	);
}

describe("matchModeWhitespaceInValue", () => {
	it.each([
		["fuzzy", "Alice Smith"],
		["phonetic", "John  Doe"],
		["fuzzy", "Alice\tSmith"],
		["phonetic", "Alice\nSmith"],
	] as const)(
		"refuses %s value %j on its actual CSQL carrier",
		(mode, value) => {
			const hits = findings(
				candidate(match(prop("patient", "case_name"), value, mode)),
			);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({
				code: CODE,
				details: {
					mode,
					value,
					slot: "caseListConfig.searchInputs[0].predicate",
				},
			});
		},
	);
	it.each(["fuzzy", "phonetic"] as const)(
		"admits a single token for %s",
		(mode) => {
			expectAdmittedDoc(
				candidate(match(prop("patient", "case_name"), "Alice", mode)),
			);
		},
	);
	it("admits a multiword starts-with literal", () => {
		expectAdmittedDoc(
			candidate(
				match(prop("patient", "case_name"), "Alice Smith", "starts-with"),
			),
		);
	});
	it.each([multiSelectAny, multiSelectAll])(
		"refuses multiword membership values",
		(membership) => {
			const hits = findings(
				candidate(
					membership(
						prop("patient", "tags"),
						literal("Alice Smith"),
						literal("Bob"),
					),
				),
			);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({
				code: CODE,
				details: {
					operator: "multi-select-contains",
					value: "Alice Smith",
					property: "tags",
				},
			});
			expectAdmittedDoc(
				candidate(
					membership(prop("patient", "tags"), literal("Alice"), literal("Bob")),
				),
			);
		},
	);
	it("attributes each whitespace repair across filter, advanced input and search button", () => {
		const predicate = match(
			prop("patient", "case_name"),
			"Alice Smith",
			"fuzzy",
		);
		const doc = candidate(predicate);
		const uuid = doc.moduleOrder[0];
		const module = doc.modules[uuid];
		if (!module.caseListConfig)
			throw new Error("Missing fixture configuration");
		const value = {
			...doc,
			modules: {
				...doc.modules,
				[uuid]: {
					...module,
					caseListConfig: { ...module.caseListConfig, filter: predicate },
					caseSearchConfig: { searchButtonDisplayCondition: predicate },
				},
			},
		};
		// Fuzzy on the filter/button also has a separate device portability error;
		// this candidate tests attribution, and does not claim admission there.
		expect(
			findings(value)
				.filter((finding) => finding.code === CODE)
				.map((finding) => finding.details?.slot),
		).toEqual([
			"caseListConfig.filter",
			"caseListConfig.searchInputs[0].predicate",
			"caseSearchConfig.searchButtonDisplayCondition",
		]);
	});
});
