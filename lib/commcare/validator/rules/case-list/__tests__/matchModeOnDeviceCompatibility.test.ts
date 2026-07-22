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
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	advancedSearchInputDef,
	asUuid,
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
import { errorIdentity } from "../../../gate";
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
			case_property_on: "patient",
		}),
	],
};

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "dob", label: "Date of birth", data_type: "date" as const },
		],
	},
];

describe("matchModeOnDeviceCompatibility", () => {
	it("fires for fuzzy match in caseListConfig.filter", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(prop("patient", "case_name"), "Alice", "fuzzy"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(prop("patient", "case_name"), "Alice", "phonetic"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(prop("patient", "case_name"), "Ali", "starts-with"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							{
								kind: "advanced",
								uuid: asUuid("si-1"),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("rejects a fuzzy match nested in an advanced value expression that CSQL inlines on-device", () => {
		const inputUuid = asUuid("si-1");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-count"),
								"child_count",
								"Matching children",
								"text",
								gt(
									count(
										subcasePath("parent", "patient"),
										match(prop("patient", "case_name"), "Alice", "fuzzy"),
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

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("normalizes a right-side subcase count before deciding its filter stays server-side", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-count-right"),
								"child_count_right",
								"Matching children",
								"text",
								eq(
									literal(0),
									count(
										subcasePath("parent", "patient"),
										match(prop("patient", "case_name"), "Alice", "phonetic"),
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

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("rejects a match inside a count shape that CSQL evaluates on-device", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-runtime-count"),
								"runtime_count",
								"Current matches",
								"text",
								gt(
									count(
										selfPath(),
										match(prop("patient", "case_name"), "Alice", "fuzzy-date"),
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

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: matchNone(),
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-dead"),
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

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("reports one actionable finding when multiple offenders share a slot", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("filter");
	});

	it("rejects a nested unsupported match in a runtime calculated field", () => {
		const columnUuid = asUuid("column-derived");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("c-1"), "case_name", "Name"),
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

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
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

	it("ignores a fully off-screen unsorted calculated definition", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("c-1"), "case_name", "Name"),
							calculatedColumn(
								asUuid("column-retired"),
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

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("rejects nested unsupported matches in every search-input default", () => {
		const simpleUuid = asUuid("input-simple");
		const advancedUuid = asUuid("input-advanced");
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
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

		const moved = {
			...hits[1],
			details: {
				...hits[1].details,
				slot: "caseListConfig.searchInputs[99].default",
			},
		};
		expect(errorIdentity(moved)).toBe(errorIdentity(hits[1]));
	});

	it("rejects a nested unsupported match in the assigned-cases expression", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
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

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.surface).toBe("excluded-owner-ids");
		expect(userFacingError(hits[0])).toContain("assigned cases setting");
	});

	it("ignores matches removed from filter and button conditions by wire simplification", () => {
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
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: dead,
						searchInputs: [],
					},
					caseSearchConfig: { searchButtonDisplayCondition: dead },
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE)).toEqual(
			[],
		);
	});

	it("short-circuits when neither on-device-lowering slot is present", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
