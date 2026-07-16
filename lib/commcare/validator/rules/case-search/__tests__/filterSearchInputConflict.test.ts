/**
 * Tests for the `filterSearchInputConflict` rule. One invariant
 * per `it(...)` block; pins the AND-composition authoring
 * ambiguity (filter + simple-arm input bind the same runtime path
 * to two distinct values) Nova surfaces when `caseSearchConfig` is
 * present, with via-aware dedup so cross-walk paths don't false-
 * positive.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	matchAll,
	prop,
	relationStep,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("filterSearchInputConflict", () => {
	it("fires when filter and simple-arm input resolve to the same `(destination, property)` pair", () => {
		// Self-walk-vs-self-walk: filter `prop("patient", "region")`
		// + simple input `{ property: "region" }` both resolve to
		// `(patient, region)` — same runtime path, AND-composition
		// authoring ambiguity (two filters on the same property,
		// neither one obviously intended over the other).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "region"), literal("North")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		);
		expect(hits.length).toBe(1);
		// Elm-style three-component message: pin the property +
		// destination case type (the runtime path) so the author
		// understands which runtime path Nova flagged as ambiguous.
		expect(hits[0].message).toContain('"region"');
		expect(hits[0].message).toContain('"patient"');
		expect(hits[0].message).toContain("caseListConfig.filter");
	});

	it("does NOT fire when filter (cross-walk) and simple-arm input (self-walk) target distinct destinations", () => {
		// Cross-walk vs self-walk on the same bare property name:
		// filter `prop("patient", "region", ancestor[parent])` →
		// destination `household.region`; simple input `{ property:
		// "region" }` → destination `patient.region`. The wire layer
		// AND-composes both bindings against DIFFERENT cases — no
		// conflict, so the rule must silently admit.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(
							prop(
								"patient",
								"region",
								ancestorPath(relationStep("parent", "household")),
							),
							literal("North"),
						),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
				{
					name: "household",
					properties: [{ name: "region", label: "Region", data_type: "text" }],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});

	it("emits one error per `(destination, property)` pair even with multiple filter references", () => {
		// Filter references `region` twice on the same self-walk
		// destination. The dedup keys on the resolved
		// `(destinationCaseType, property)` pair so only one error
		// surfaces.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: {
							kind: "and",
							clauses: [
								eq(prop("patient", "region"), literal("North")),
								eq(prop("patient", "region"), literal("South")),
							],
						},
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		);
		expect(hits.length).toBe(1);
	});

	it("does not fire when filter and simple-arm inputs target disjoint properties", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "status"), literal("active")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "status",
									label: "Status",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
						{ name: "status", label: "Status", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});

	it("ignores advanced-arm inputs (no schema-layer property binding)", () => {
		// Advanced-arm inputs author their own predicate; they don't
		// bind a single property at the schema layer, so a filter
		// reference to the same property can't structurally collide
		// with them. The advanced predicate's references are covered
		// by `searchInputPredicateTypeCheck`.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "region"), literal("North")),
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-advanced"),
								"region_advanced",
								"Region (advanced)",
								"text",
								matchAll(),
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});

	it("covers legacy markerless search inputs because they still emit search", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "region"), literal("North")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "region",
									label: "Region",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).filter(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toHaveLength(1);
	});

	it("short-circuits when `mod.caseType` is absent", () => {
		// Without `caseType`, the originating scope for the simple
		// input's via-walk is unknowable. The structural module rules
		// (`NO_CASE_TYPE`) catch this elsewhere — this rule passes
		// silently to avoid emitting noise on a doc with the deeper
		// structural error.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					// No caseType
					caseListOnly: true,
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "region"), literal("North")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
							),
						],
					},
					caseSearchConfig: {},
					forms: [],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "region", label: "Region", data_type: "text" }],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});

	it("treats a legacy property alias and its canonical name as one binding", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Viewer",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						filter: eq(prop("patient", "external_id"), literal("fixed")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-external"),
								"external_id",
								"External ID",
								"text",
								"external-id",
							),
						],
					},
					caseSearchConfig: {},
					forms: [],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});

		expect(
			runValidation(doc).filter(
				(error) => error.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toHaveLength(1);
	});
});
