/**
 * Tests for `caseSearchConfigRequiresSearchableSurface`. Fires when
 * a module has `caseSearchConfig` but neither a search filter nor
 * any search inputs — the search button would render but reach an
 * unsearchable surface.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { and, eq, literal, matchAll, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE" as const;

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
		],
	},
];

describe("caseSearchConfigRequiresSearchableSurface", () => {
	it("fires when caseSearchConfig is present but filter and searchInputs are both empty", () => {
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
						searchScreenTitle: "Find a patient",
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		// Message names all three remediation paths so the author knows
		// which surface to extend.
		expect(hits[0].message).toContain("searchInputs");
		expect(hits[0].message).toContain("caseListConfig.filter");
		expect(hits[0].message).toContain("remove `caseSearchConfig`");
	});

	it("is silent when caseSearchConfig is absent (no search button to render)", () => {
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
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent when caseSearchConfig is present and at least one search input is configured", () => {
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
								asUuid("si-1"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent when caseSearchConfig is present and a non-match-all filter narrows the result set", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: eq(prop("patient", "case_name"), literal("Alice")),
						searchInputs: [],
					},
					caseSearchConfig: {},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("still fires when filter is match-all (no narrowing effect)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: { kind: "match-all" },
						searchInputs: [],
					},
					caseSearchConfig: {},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("still fires when filter REDUCES to match-all (and(match-all, match-all))", () => {
		// The gate must agree with emission: a filter whose `kind` is
		// `and` but which normalizes to match-all narrows nothing and
		// emits no query, so it is not a searchable surface. A shallow
		// top-level check would miss this and pass an unsearchable config.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: and(matchAll(), matchAll()),
						searchInputs: [],
					},
					caseSearchConfig: {},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});
});
