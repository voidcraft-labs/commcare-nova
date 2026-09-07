import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `matchModeOnDeviceCompatibility`. JavaRosa on-device
 * XPath registers `starts-with` but has no entry for `fuzzy-match`,
 * `phonetic-match`, or `fuzzy-date` — those are CCHQ-server-only
 * functions. The rule inventories every module Predicate/ValueExpression
 * slot that actually lowers on-device, while leaving an advanced search
 * input's CSQL-only predicate body alone.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	advancedSearchInputDef,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	coalesce,
	count,
	dateLiteral,
	eq,
	gt,
	ifExpr,
	literal,
	match,
	matchAll,
	matchNone,
	not,
	or,
	prop,
	selfPath,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_MATCH_MODE_NOT_ON_DEVICE" as const;

const standardForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
};

const standardCaseTypes = [
	{ name: "visit", parent_type: "patient", properties: [] },
	{
		name: "patient",
		properties: [
			{ name: "dob", label: "Date of birth", data_type: "date" as const },
		],
	},
];

// Isolated diagnostic assertions below may coexist with a distinct global
// scope refusal. A zero compatibility result is only accepted when the whole
// candidate is admitted.
function compatibilityFindings(doc: ReturnType<typeof buildDoc>) {
	const all = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	const hits = all.filter((error) => error.code === CODE);
	if (hits.length === 0) expectAdmittedDoc(doc);
	return hits;
}

describe("matchModeOnDeviceCompatibility", () => {
	it("fires for fuzzy match in caseListConfig.filter", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: match(prop("patient", "case_name"), "Alice", "fuzzy"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("`fuzzy` match");
		expect(hits[0].message).toContain("Cases available rule");
		expect(hits[0].details?.mode).toBe("fuzzy");
		expect(hits[0].details?.property).toBe("case_name");
		expect(hits[0].details?.surface).toBe("filter");
	});

	it("fires for phonetic match in caseListConfig.filter", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: match(prop("patient", "case_name"), "Alice", "phonetic"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("phonetic");
	});

	it("fires for fuzzy-date match in caseListConfig.filter", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: match(
							prop("patient", "dob"),
							dateLiteral("2020-01-15"),
							"fuzzy-date",
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("fuzzy-date");
	});

	it("admits starts-with mode in caseListConfig.filter — JavaRosa has the function", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: match(prop("patient", "case_name"), "Ali", "starts-with"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(0);
	});

	it("fires for a fuzzy match nested inside an `and`", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: and(
							eq(prop("patient", "case_name"), literal("Alice")),
							match(prop("patient", "case_name"), "Smith", "fuzzy"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("fuzzy");
	});

	it("fires for a phonetic match nested inside `not`", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: not(
							match(prop("patient", "case_name"), "Alice", "phonetic"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("phonetic");
	});

	it("fires for a fuzzy match nested in an if condition inside a value expression", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: eq(
							coalesce(
								ifExpr(
									match(prop("patient", "case_name"), "Alice", "fuzzy"),
									term(literal("yes")),
									term(literal("no")),
								),
								term(literal("fallback")),
							),
							literal("yes"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("fuzzy");
		expect(hits[0].details?.slot).toBe("caseListConfig.filter");
	});

	it("fires for a phonetic match nested in count.where on the search-button condition", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: gt(
							count(
								selfPath(),
								match(prop("patient", "case_name"), "Alice", "phonetic"),
							),
							literal(0),
						),
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("phonetic");
		expect(hits[0].details?.slot).toBe(
			"caseSearchConfig.searchButtonDisplayCondition",
		);
	});

	it("fires for fuzzy match in caseSearchConfig.searchButtonDisplayCondition", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: match(
							prop("patient", "case_name"),
							"Alice",
							"fuzzy",
						),
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.slot).toBe(
			"caseSearchConfig.searchButtonDisplayCondition",
		);
		expect(userFacingError(hits[0])).toContain("Search button condition");
	});

	it("is silent on advanced-arm search input predicates — those route only through CSQL", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [
							{
								kind: "advanced",
								uuid: testUuid("si-1"),
								name: "name_q",
								label: "Name",
								type: "text",
								predicate: match(
									prop("patient", "case_name"),
									"Alice",
									"fuzzy",
								),
							},
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(0);
	});

	it("rejects a fuzzy match nested in an advanced value expression that CSQL inlines on-device", () => {
		const inputUuid = testUuid("si-1");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [
							{
								kind: "advanced",
								uuid: inputUuid,
								name: "name_q",
								label: "Name",
								type: "text",
								predicate: eq(
									ifExpr(
										match(prop("patient", "case_name"), "Alice", "fuzzy"),
										term(literal("yes")),
										term(literal("no")),
									),
									literal("yes"),
								),
							},
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputUuid,
			surface: "advanced-input",
		});
		expect(userFacingError(hits[0])).toContain(
			'The condition for search field "Name"',
		);
	});

	it("keeps a fuzzy match inside a native direct-LHS subcase count server-side", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [
							advancedSearchInputDef(
								testUuid("si-count"),
								"child_count",
								"Matching children",
								"text",
								gt(
									count(
										subcasePath("parent", "visit"),
										match(prop("visit", "case_name"), "Alice", "fuzzy"),
									),
									literal(0),
								),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(compatibilityFindings(doc)).toEqual([]);
	});

	it("normalizes a right-side subcase count before deciding its filter stays server-side", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [
							advancedSearchInputDef(
								testUuid("si-count-right"),
								"child_count_right",
								"Matching children",
								"text",
								eq(
									literal(0),
									count(
										subcasePath("parent", "visit"),
										match(prop("visit", "case_name"), "Alice", "phonetic"),
									),
								),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(compatibilityFindings(doc)).toEqual([]);
	});

	it("rejects a match inside a count shape that CSQL evaluates on-device", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [
							advancedSearchInputDef(
								testUuid("si-runtime-count"),
								"runtime_count",
								"Current matches",
								"text",
								gt(
									count(
										selfPath(),
										match(
											prop("patient", "dob"),
											dateLiteral("2020-01-15"),
											"fuzzy-date",
										),
									),
									literal(0),
								),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			mode: "fuzzy-date",
			surface: "advanced-input",
		});
	});

	it("drops an advanced runtime finding when match-none absorbs the composed CSQL", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: matchNone(),
						searchInputs: [
							advancedSearchInputDef(
								testUuid("si-dead"),
								"dead_q",
								"Dead condition",
								"text",
								eq(
									ifExpr(
										match(prop("patient", "case_name"), "Alice", "fuzzy"),
										term(literal("yes")),
										term(literal("no")),
									),
									literal("yes"),
								),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(compatibilityFindings(doc)).toEqual([]);
	});

	it("reports one actionable finding when multiple offenders share a slot", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: and(
							match(prop("patient", "case_name"), "Alice", "fuzzy"),
							match(prop("patient", "case_name"), "Bob", "phonetic"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("filter");
	});

	it("rejects a nested unsupported match in a runtime calculated field", () => {
		const columnUuid = testUuid("column-derived");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("c-1"), "case_name", "Name"),
							calculatedColumn(
								columnUuid,
								"Name quality",
								ifExpr(
									match(prop("patient", "case_name"), "Alice", "phonetic"),
									term(literal("close")),
									term(literal("different")),
								),
							),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			columnLabel: "Name quality",
			columnUuid,
			surface: "calculated-column",
		});
		expect(userFacingError(hits[0])).toContain(
			'The calculation for field "Name quality"',
		);
		expect(userFacingError(hits[0])).not.toContain("advanced search");
	});

	it("checks a fully off-screen unsorted calculated definition", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("c-1"), "case_name", "Name"),
							calculatedColumn(
								testUuid("column-retired"),
								"Retired",
								ifExpr(
									match(prop("patient", "case_name"), "Alice", "fuzzy"),
									term(literal("yes")),
									term(literal("no")),
								),
								{ visibleInList: false, visibleInDetail: false },
							),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			columnLabel: "Retired",
			columnUuid: testUuid("column-retired"),
			surface: "calculated-column",
		});
	});

	it("rejects nested unsupported matches in every search-input default", () => {
		const simpleUuid = testUuid("input-simple");
		const advancedUuid = testUuid("input-advanced");
		const unsupportedDefault = ifExpr(
			match(prop("patient", "case_name"), "Alice", "fuzzy"),
			term(literal("Alice")),
			term(literal("")),
		);
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								simpleUuid,
								"name_q",
								"Client name",
								"text",
								"case_name",
								{ default: unsupportedDefault },
							),
							advancedSearchInputDef(
								advancedUuid,
								"advanced_q",
								"Similar name",
								"text",
								match(prop("patient", "case_name"), "Bob", "phonetic"),
								{ default: unsupportedDefault },
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.details?.inputUuid)).toEqual([
			simpleUuid,
			advancedUuid,
		]);
		expect(
			hits.every((hit) => hit.details?.surface === "search-input-default"),
		).toBe(true);
		expect(userFacingError(hits[1])).toContain(
			'The default for search field "Similar name"',
		);
	});

	it("rejects a nested unsupported match in the assigned-cases expression", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						searchInputs: [],
					},
					caseSearchConfig: {
						excludedOwnerIds: ifExpr(
							match(prop("patient", "case_name"), "Alice", "fuzzy"),
							term(literal("owner-a")),
							term(literal("")),
						),
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("excluded-owner-ids");
		expect(userFacingError(hits[0])).toContain("assigned cases setting");
	});

	it("simplifies the filter while the global scope rule still refuses a case-reading button", () => {
		const dead = or(
			matchAll(),
			match(prop("patient", "case_name"), "Alice", "fuzzy"),
		);
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("c-1")],
						detailColumnOrder: [testUuid("c-1")],
						filter: dead,
						searchInputs: [],
					},
					caseSearchConfig: { searchButtonDisplayCondition: dead },
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code),
		).toEqual(["CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE"]);
	});

	it("admits a plain case list with no expression carriers", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("plain-column"), "case_name", "Name"),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = compatibilityFindings(doc);
		expect(hits).toHaveLength(0);
	});
});
