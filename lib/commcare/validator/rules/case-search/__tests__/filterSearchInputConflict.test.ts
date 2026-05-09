/**
 * Tests for the `filterSearchInputConflict` rule. One invariant per
 * `it(...)` block; pins the AND-composition conflict (filter +
 * simple-arm input) the wire layer rejects when `caseSearchConfig`
 * is present.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, matchAll, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("filterSearchInputConflict", () => {
	it("fires when a property appears in both the filter and a simple-arm search input", () => {
		// Filter references `region`; simple-arm input also targets
		// `region` — the two AND-compose into one wire query.
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
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		);
		expect(hits.length).toBe(1);
		// Elm-style three-component message: pin the conflicting
		// property name AND surface the dual-binding shape so the
		// author understands why the wire layer rejects it.
		expect(hits[0].message).toContain('"region"');
		expect(hits[0].message).toContain("caseListConfig.filter");
		expect(hits[0].message).toContain("caseListConfig.searchInputs");
	});

	it("emits one error per conflicting property name even when the filter references it multiple times", () => {
		// Filter references `region` twice (an `eq` and another `eq`
		// inside an `and`). Only one error surfaces — the rule
		// dedupes by property name so the author isn't drowned in
		// duplicates.
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
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		);
		expect(hits.length).toBe(1);
	});

	it("does not fire when the filter and simple-arm inputs use disjoint properties", () => {
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
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
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
		// with them at the wire layer.
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
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
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
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});

	it("short-circuits when `caseSearchConfig` is absent", () => {
		// Without `caseSearchConfig`, no `<remote-request>` is emitted
		// — the filter and search inputs may share property names
		// without the AND-composition conflict the wire layer rejects.
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
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
			),
		).toBe(false);
	});
});
