// components/builder/case-list-config/__tests__/configValidity.test.ts
//
// Pins the pure whole-config verdicts (tab dots, in-canvas marks,
// preview gate). The verdicts must mirror what the entity editors
// surface: a config every editor would render error-free carries no
// dots or marks; a config any editor would flag does, and the
// preview pauses ONLY for the ASTs the SQL compiler consumes.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
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
	matchesPattern,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { proseTemplateText, proseText } from "@/lib/domain/prose";

import { caseListConfigVerdicts } from "../configValidity";

/** Every fixture property below is labeled with literal prose, so a
 *  context-free projection spells exactly what a document-aware one would. */
const projectProse = proseTemplateText;

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
			{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
			{ name: "age", label: proseText("Age"), data_type: "int" },
			{ name: "score", label: proseText("Score"), data_type: "int" },
		],
	} as CaseType,
];

function config(partial: Partial<CaseListConfig>): CaseListConfig {
	return resolveCaseListConfig({ columns: [], searchInputs: [], ...partial });
}

function verdicts(partial: Partial<CaseListConfig>) {
	return caseListConfigVerdicts(
		config(partial),
		CASE_TYPES,
		"patient",
		projectProse,
	);
}

const CLEAN = { search: false, list: false, detail: false };

const TOP_LEFT = { x: 0, y: 0, width: 6, height: 1 };
const TOP_RIGHT = { x: 6, y: 0, width: 6, height: 1 };

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
				plainColumn(testUuid("c1"), "case_name", "Name"),
				dateColumn(testUuid("c2"), "dob", "DOB", "%d/%m/%Y"),
			],
			filter: {
				kind: "neq",
				left: term(prop("patient", "case_name")),
				right: term(literal("")),
			},
			searchInputs: [
				simpleSearchInputDef(
					testUuid("s1"),
					"patient_name",
					"Patient name",
					"text",
					"case_name",
				),
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.filterBroken).toBe(false);
	});

	it("checks Results filters against a date field's runtime date value", () => {
		const searchInputUuid = testUuid("date-search");
		const v = verdicts({
			filter: eq(prop("patient", "dob"), input(searchInputUuid)),
			searchInputs: [
				simpleSearchInputDef(
					searchInputUuid,
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
			columns: [dateColumn(testUuid("c1"), "case_name", "Name", "%d/%m/%Y")],
		});
		// The mark + both tab dots (the default column appears on both screens)…
		expect(v.brokenColumns.has(testUuid("c1"))).toBe(true);
		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("badges only Details for a broken Details-only field", () => {
		const column = {
			...dateColumn(testUuid("details-only"), "case_name", "Name", "%d/%m/%Y"),
			visibleInList: false,
		};
		const v = verdicts({ columns: [column] });

		expect(v.brokenColumns.has(column.uuid)).toBe(true);
		expect(v.errorAreas.list).toBe(false);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("attributes a broken off-screen sort carrier to Results only", () => {
		const column = {
			...dateColumn(testUuid("sort-carrier"), "case_name", "Name", "%d/%m/%Y"),
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
				properties: [{ name: "mystery", label: proseText("Mystery") }],
			} as CaseType,
		];
		const v = caseListConfigVerdicts(
			config({
				columns: [dateColumn(testUuid("c1"), "mystery", "M", "%d/%m/%Y")],
			}),
			caseTypes,
			"patient",
			projectProse,
		);
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.brokenColumns.size).toBe(0);
	});

	it("marks a calculated column whose expression fails its type check", () => {
		const v = verdicts({
			columns: [
				// References a property that doesn't exist on the case type.
				calculatedColumn(
					testUuid("c1"),
					"Calc",
					term(prop("patient", "missing_prop")),
				),
			],
		});
		expect(v.brokenColumns.has(testUuid("c1"))).toBe(true);
		expect(v.errorAreas.list).toBe(true);
		expect(v.errorAreas.detail).toBe(true);
	});

	it("marks an invalid dormant calculation without assigning it to a screen", () => {
		const hidden = {
			...calculatedColumn(
				testUuid("hidden-calc"),
				"Old calculation",
				term(prop("patient", "missing_prop")),
			),
			visibleInList: false,
			visibleInDetail: false,
		};
		const v = verdicts({ columns: [hidden] });

		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.brokenColumns).toEqual(new Set([testUuid("hidden-calc")]));
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
					testUuid("c1"),
					"A",
					term(prop("patient", "missing_prop")),
				),
				calculatedColumn(
					testUuid("c2"),
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
		expect(v.brokenColumns).toEqual(new Set([testUuid("c1"), testUuid("c2")]));
	});

	it("flags structural search-input errors on the search tab only", () => {
		const v = verdicts({
			searchInputs: [
				simpleSearchInputDef(testUuid("s1"), "a", "", "text", "case_name"),
				simpleSearchInputDef(
					testUuid("s2"),
					"a",
					"Second",
					"text",
					"case_name",
				),
			],
		});
		expect(v.errorAreas.search).toBe(true);
		expect(v.errorAreas.list).toBe(false);
	});

	it("admits a pattern match in a prompt's required condition and check, the two device-evaluated slots", () => {
		const name = testUuid("pattern-name");
		const v = verdicts({
			searchInputs: [
				simpleSearchInputDef(name, "name", "Name", "text", "case_name", {
					required: { when: matchesPattern(input(name), "^Dr") },
					validation: {
						rule: matchesPattern(input(name), "^[A-Z]"),
						message: "Start with a capital letter",
					},
				}),
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
	});

	it("accepts the final date-range shape", () => {
		const v = verdicts({
			searchInputs: [
				simpleSearchInputDef(
					testUuid("range-mode"),
					"dob",
					"DOB",
					"date-range",
					"dob",
				),
			],
		});

		expect(v.errorAreas).toEqual(CLEAN);
	});

	it("accepts an advanced input whose condition references its own input", () => {
		// The custom-condition seed self-references the row's own input
		// via the when-input-present envelope. The edited row must be in
		// scope for that to resolve: otherwise the gate flags a condition
		// the commit gate and wire emitter accept.
		const searchInputUuid = testUuid("s1");
		const v = verdicts({
			searchInputs: [
				advancedSearchInputDef(
					searchInputUuid,
					"name",
					"Name",
					"text",
					whenInput(
						input(searchInputUuid),
						eq(prop("patient", "case_name"), input(searchInputUuid)),
					),
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
			projectProse,
			{ caseSearchEnabled: false },
		);
		const searchBacked = caseListConfigVerdicts(
			propertyComparison,
			CASE_TYPES,
			"patient",
			projectProse,
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
			projectProse,
			{
				boundary: { ...baseBoundary, searchButtonConditionBroken: true },
			},
		);
		const assignedCases = caseListConfigVerdicts(
			config({}),
			CASE_TYPES,
			"patient",
			projectProse,
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
	// ── Tile placement ──
	//
	// A tile problem is a Results problem. It marks the field so the tab
	// dot leads somewhere findable, and it deliberately stays OUT of
	// `brokenColumns`, which Details reads too.

	it("reports a well-placed tile clean", () => {
		const v = verdicts({
			tile: {},
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: TOP_LEFT,
				},
				{ ...plainColumn(testUuid("c2"), "age", "Age"), tile: TOP_RIGHT },
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.tileIssues.size).toBe(0);
	});

	it("badges Results for a cell that runs past the edge of the grid", () => {
		const v = verdicts({
			tile: {},
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: { x: 8, y: 0, width: 6, height: 1 },
				},
			],
		});
		expect(v.errorAreas).toEqual({ search: false, list: true, detail: false });
		expect(v.tileIssues.get(testUuid("c1"))?.[0]).toContain(
			"runs past the edge of the tile",
		);
	});

	it("checks stored geometry even while Results shows rows", () => {
		// Continuous geometry checking is what guarantees that turning the
		// tile back on is always accepted.
		const v = verdicts({
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: { x: 8, y: 0, width: 6, height: 1 },
				},
			],
		});
		expect(v.errorAreas.list).toBe(true);
		expect(v.tileIssues.size).toBe(1);
	});

	it("marks both fields of an overlapping pair", () => {
		const v = verdicts({
			tile: {},
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: TOP_LEFT,
				},
				{
					...plainColumn(testUuid("c2"), "age", "Age"),
					tile: { x: 3, y: 0, width: 6, height: 1 },
				},
			],
		});
		expect([...v.tileIssues.keys()].sort()).toEqual(
			[testUuid("c1"), testUuid("c2")].sort(),
		);
	});

	it("badges Results, never Details, for a field shown on both screens", () => {
		const v = verdicts({
			tile: {},
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: { x: 8, y: 0, width: 6, height: 1 },
				},
			],
		});
		expect(v.errorAreas.detail).toBe(false);
		expect(v.brokenColumns.size).toBe(0);
	});

	it("reports coverage only while the tile is on", () => {
		const columns = [
			{
				...plainColumn(testUuid("c1"), "case_name", "Name"),
				tile: TOP_LEFT,
			},
			plainColumn(testUuid("c2"), "age", "Age"),
		];
		expect(verdicts({ columns }).errorAreas).toEqual(CLEAN);
		const on = verdicts({ tile: {}, columns });
		expect(on.errorAreas.list).toBe(true);
		expect(on.tileIssues.get(testUuid("c2"))?.[0]).toContain(
			"has no place on the tile",
		);
	});

	it("asks for no place from a hidden field that drives the default order", () => {
		// That field reaches the wire as CommCare's reserved zero-width
		// carrier, which draws nothing, so it needs no square.
		const v = verdicts({
			tile: {},
			columns: [
				{
					...plainColumn(testUuid("c1"), "case_name", "Name"),
					tile: TOP_LEFT,
				},
				{
					...plainColumn(testUuid("c2"), "age", "Age"),
					visibleInList: false,
					sort: { direction: "asc" as const, priority: 1 },
				},
			],
		});
		expect(v.errorAreas).toEqual(CLEAN);
		expect(v.tileIssues.size).toBe(0);
	});
});
