/**
 * Tests for `matchModeOnDeviceCompatibility`. JavaRosa on-device
 * XPath registers `starts-with` but has no entry for `fuzzy-match`,
 * `phonetic-match`, or `fuzzy-date` — those are CCHQ-server-only
 * functions. The rule rejects the three CSQL-only modes on slots
 * that lower to on-device XPath (`caseListConfig.filter` and
 * `caseSearchConfig.searchButtonDisplayCondition`), pointing the
 * author at the advanced-arm search input slot — which routes only
 * through CSQL and admits the full mode set.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn } from "@/lib/domain";
import {
	and,
	dateLiteral,
	eq,
	literal,
	match,
	not,
	prop,
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("`fuzzy` match");
		expect(hits[0].message).toContain("caseListConfig.filter");
		expect(hits[0].message).toContain("advanced-arm");
		expect(hits[0].details?.mode).toBe("fuzzy");
		expect(hits[0].details?.property).toBe("case_name");
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details?.mode).toBe("phonetic");
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain(
			"caseSearchConfig.searchButtonDisplayCondition",
		);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("flags every offending match when multiple appear in one filter", () => {
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(2);
		const modes = hits.map((h) => h.details?.mode).sort();
		expect(modes).toEqual(["fuzzy", "phonetic"]);
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
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
