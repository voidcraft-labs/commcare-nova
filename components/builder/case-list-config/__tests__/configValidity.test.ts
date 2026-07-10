// components/builder/case-list-config/__tests__/configValidity.test.ts
//
// Pins the pure whole-config verdicts (tab dots, in-canvas marks,
// preview gate). The verdicts must mirror what the entity editors
// surface: a config every editor would render error-free carries no
// dots or marks; a config any editor would flag does — and the
// preview pauses ONLY for the ASTs the SQL compiler consumes.

import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	dateColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { asUuid } from "@/lib/domain/uuid";
import { caseListConfigVerdicts } from "../configValidity";

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "dob", label: "Date of birth", data_type: "date" },
		],
	} as CaseType,
];

function config(partial: Partial<CaseListConfig>): CaseListConfig {
	return { columns: [], searchInputs: [], ...partial };
}

function verdicts(partial: Partial<CaseListConfig>) {
	return caseListConfigVerdicts(config(partial), CASE_TYPES, "patient");
}

const CLEAN = { search: false, list: false, detail: false };

describe("caseListConfigVerdicts", () => {
	it("reports an empty config clean", () => {
		const v = verdicts({});
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.brokenColumns.size).toBe(0);
		expect(v.previewObstacle).toBeNull();
	});

	it("reports well-typed columns, filter, and inputs clean", () => {
		const v = verdicts({
			columns: [
				plainColumn(asUuid("c1"), "name", "Name"),
				dateColumn(asUuid("c2"), "dob", "DOB", "%d/%m/%Y"),
			],
			filter: {
				kind: "neq",
				left: term(prop("patient", "name")),
				right: term(literal("")),
			},
			searchInputs: [
				simpleSearchInputDef(
					asUuid("s1"),
					"patient_name",
					"Patient name",
					"text",
					"name",
				),
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.previewObstacle).toBeNull();
	});

	it("marks a kind-vs-property mismatch (date column on a DECLARED text property) without pausing the preview", () => {
		const v = verdicts({
			columns: [dateColumn(asUuid("c1"), "name", "Name", "%d/%m/%Y")],
		});
		// The mark + both tab dots (both canvases render every column)…
		expect(v.brokenColumns.has(asUuid("c1"))).toBe(true);
		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(true);
		// …but the live rows keep running: an applicability mismatch is a
		// formatting concern, not an AST the SQL compiler would choke on.
		expect(v.previewObstacle).toBeNull();
	});

	it("accepts a date column on a property with NO resolved type (honest unknown)", () => {
		const caseTypes: CaseType[] = [
			{
				name: "patient",
				properties: [{ name: "mystery", label: "Mystery" }],
			} as CaseType,
		];
		const v = caseListConfigVerdicts(
			config({
				columns: [dateColumn(asUuid("c1"), "mystery", "M", "%d/%m/%Y")],
			}),
			caseTypes,
			"patient",
		);
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.brokenColumns.size).toBe(0);
	});

	it("pauses the preview for a calculated column whose expression fails its type check, naming it", () => {
		const v = verdicts({
			columns: [
				// References a property that doesn't exist on the case type.
				calculatedColumn(
					asUuid("c1"),
					"Calc",
					term(prop("patient", "missing_prop")),
				),
			],
		});
		expect(v.brokenColumns.has(asUuid("c1"))).toBe(true);
		expect(v.previewObstacle).toContain('the calculated column "Calc"');
		expect(v.previewObstacle).toContain("has an error");
	});

	it("pauses the preview for a filter that references an unknown property", () => {
		const v = verdicts({
			filter: {
				kind: "eq",
				left: term(prop("patient", "missing_prop")),
				right: term(literal("x")),
			},
		});
		expect(v.errorAreas.list).toBe(true);
		expect(v.previewObstacle).toContain("the filter has an error");
	});

	it("pluralizes the obstacle across the filter and several calculated columns", () => {
		const v = verdicts({
			columns: [
				calculatedColumn(
					asUuid("c1"),
					"A",
					term(prop("patient", "missing_prop")),
				),
				calculatedColumn(
					asUuid("c2"),
					"B",
					term(prop("patient", "missing_prop")),
				),
			],
			filter: {
				kind: "eq",
				left: term(prop("patient", "missing_prop")),
				right: term(literal("x")),
			},
		});
		expect(v.previewObstacle).toContain(
			"the filter and 2 calculated columns have errors",
		);
	});

	it("flags structural search-input errors on the search tab only, without pausing", () => {
		const v = verdicts({
			searchInputs: [
				simpleSearchInputDef(asUuid("s1"), "a", "", "text", "name"),
				simpleSearchInputDef(asUuid("s2"), "a", "Second", "text", "name"),
			],
		});
		expect(v.errorAreas.search).toBe(true);
		expect(v.errorAreas.list).toBe(false);
		expect(v.previewObstacle).toBeNull();
	});

	it("accepts an advanced input whose condition references its own input", () => {
		// The custom-condition seed self-references the row's own input
		// via the when-input-present envelope. The edited row must be in
		// scope for that to resolve — otherwise the gate flags a condition
		// the commit gate and wire emitter accept.
		const v = verdicts({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("s1"),
					"name",
					"Name",
					"text",
					whenInput(input("name"), eq(prop("patient", "name"), input("name"))),
				),
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
	});

	it("accepts a match-all filter (the empty-filter seed)", () => {
		const v = verdicts({ filter: matchAll() });
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.previewObstacle).toBeNull();
	});
});
