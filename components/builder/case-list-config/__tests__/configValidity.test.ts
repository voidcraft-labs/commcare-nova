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
	today,
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
			{ name: "age", label: "Age", data_type: "int" },
			{ name: "score", label: "Score", data_type: "int" },
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
		expect(v.filterBroken).toBe(false);
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
		expect(v.filterBroken).toBe(false);
	});

	it("checks Results filters against a date field's runtime date value", () => {
		const v = verdicts({
			filter: eq(prop("patient", "dob"), input("visit_date")),
			searchInputs: [
				simpleSearchInputDef(
					asUuid("date-search"),
					"visit_date",
					"Visit date",
					"date",
					"dob",
				),
			],
		});

		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.filterBroken).toBe(false);
	});

	it("marks a kind-vs-property mismatch on every screen that shows it", () => {
		const v = verdicts({
			columns: [dateColumn(asUuid("c1"), "name", "Name", "%d/%m/%Y")],
		});
		// The mark + both tab dots (the default column appears on both screens)…
		expect(v.brokenColumns.has(asUuid("c1"))).toBe(true);
		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("badges only Details for a broken Details-only field", () => {
		const column = {
			...dateColumn(asUuid("details-only"), "name", "Name", "%d/%m/%Y"),
			visibleInList: false,
		};
		const v = verdicts({ columns: [column] });

		expect(v.brokenColumns.has(column.uuid)).toBe(true);
		expect(v.errorAreas.list).toBe(false);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("attributes a broken off-screen sort carrier to Results only", () => {
		const column = {
			...dateColumn(asUuid("sort-carrier"), "name", "Name", "%d/%m/%Y"),
			visibleInList: false,
			visibleInDetail: false,
			sort: { direction: "asc" as const, priority: 0 },
		};
		const v = verdicts({ columns: [column] });

		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(false);
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

	it("marks a calculated column whose expression fails its type check", () => {
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
		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("ignores an unconsumed legacy hidden calculation until it is added back", () => {
		const hidden = {
			...calculatedColumn(
				asUuid("hidden-calc"),
				"Old calculation",
				term(prop("patient", "missing_prop")),
			),
			visibleInList: false,
			visibleInDetail: false,
		};
		const v = verdicts({ columns: [hidden] });

		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.brokenColumns.size).toBe(0);
	});

	it("marks Cases available on Results when its rule references an unknown property", () => {
		const v = verdicts({
			filter: {
				kind: "eq",
				left: term(prop("patient", "missing_prop")),
				right: term(literal("x")),
			},
		});
		expect(v.errorAreas.search).toBe(false);
		expect(v.errorAreas.list).toBe(true);
		expect(v.filterBroken).toBe(true);
	});

	it("reports the filter and several calculated columns independently", () => {
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
		expect(v.filterBroken).toBe(true);
		expect(v.brokenColumns).toEqual(new Set([asUuid("c1"), asUuid("c2")]));
	});

	it("flags structural search-input errors on the search tab only", () => {
		const v = verdicts({
			searchInputs: [
				simpleSearchInputDef(asUuid("s1"), "a", "", "text", "name"),
				simpleSearchInputDef(asUuid("s2"), "a", "Second", "text", "name"),
			],
		});
		expect(v.errorAreas.search).toBe(true);
		expect(v.errorAreas.list).toBe(false);
	});

	it("flags legacy range defaults and range/widget mismatches on Search", () => {
		const legacyDefault = verdicts({
			searchInputs: [
				simpleSearchInputDef(
					asUuid("range-default"),
					"dob",
					"DOB",
					"date-range",
					"dob",
					{ default: today() },
				),
			],
		});
		const mismatchedWidget = verdicts({
			searchInputs: [
				simpleSearchInputDef(
					asUuid("range-mode"),
					"dob",
					"DOB",
					"date",
					"dob",
					{ mode: { kind: "range" } },
				),
			],
		});

		expect(legacyDefault.errorAreas).toEqual({
			search: true,
			list: false,
			detail: false,
		});
		expect(mismatchedWidget.errorAreas).toEqual({
			search: true,
			list: false,
			detail: false,
		});
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
		expect(v.filterBroken).toBe(false);
	});

	it("applies the remote-query restriction only when Results are search-backed", () => {
		const propertyComparison = config({
			filter: eq(prop("patient", "age"), prop("patient", "score")),
		});
		const onDevice = caseListConfigVerdicts(
			propertyComparison,
			CASE_TYPES,
			"patient",
			{ caseSearchEnabled: false },
		);
		const searchBacked = caseListConfigVerdicts(
			propertyComparison,
			CASE_TYPES,
			"patient",
			{ caseSearchEnabled: true },
		);

		expect(onDevice.filterBroken).toBe(false);
		expect(onDevice.errorAreas).toEqual(CLEAN);
		expect(searchBacked.filterBroken).toBe(true);
		expect(searchBacked.errorAreas.list).toBe(true);
	});

	it("keeps Search-action and assigned-case findings owned by their settings", () => {
		const baseBoundary = {
			filterBroken: false,
			searchInputsBroken: false,
			searchButtonConditionBroken: false,
			excludedOwnerIdsBroken: false,
			brokenColumnUuids: [],
		} as const;
		const searchButton = caseListConfigVerdicts(
			config({}),
			CASE_TYPES,
			"patient",
			{
				boundary: { ...baseBoundary, searchButtonConditionBroken: true },
			},
		);
		const assignedCases = caseListConfigVerdicts(
			config({}),
			CASE_TYPES,
			"patient",
			{
				boundary: { ...baseBoundary, excludedOwnerIdsBroken: true },
			},
		);

		expect(searchButton.errorAreas).toEqual({
			search: true,
			list: false,
			detail: false,
		});
		expect(searchButton.searchButtonConditionBroken).toBe(true);
		expect(assignedCases.errorAreas).toEqual({
			search: false,
			list: true,
			detail: false,
		});
		expect(assignedCases.filterBroken).toBe(false);
		expect(assignedCases.excludedOwnerIdsBroken).toBe(true);
	});
});
