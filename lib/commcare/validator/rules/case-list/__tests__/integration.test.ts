/**
 * Cross-rule integration tests for the case-list-config validator
 * surface. Each test pins an interaction across rules: a single
 * blueprint can simultaneously trigger field-kind-vs-property-type
 * AND search-input-mode-vs-property-type errors; multi-writer
 * disagreement surfaces one error per writer; structurally clean
 * blueprints stay silent across every rule.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, rangeMode, searchInputDef } from "@/lib/domain";
import { runValidation } from "../../../runner";

describe("case-list validator — cross-rule integration", () => {
	it("surfaces both kind-mismatch and mode-mismatch on the same blueprint", () => {
		// A `text` field saves to a property declared as `int`, AND a
		// search input declares `range` against that same `int` property
		// (range admits int, so no mode mismatch — pin a separate
		// property whose `range` mode is structurally rejected).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("name_range", "Name range", "text", {
								property: "name",
								mode: rangeMode(),
							}),
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
								// Kind-mismatch — `text` field writing to an `int`
								// property. Surfaces FIELD_KIND_PROPERTY_TYPE_MISMATCH.
								f({
									kind: "text",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
								// Drives the mode-mismatch — `name` is text-typed, so
								// `range` is structurally rejected. Surfaces
								// CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH.
								f({
									kind: "text",
									id: "name",
									label: "Name (full)",
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
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "name", label: "Name", data_type: "text" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(
			errors.some((e) => e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH"),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("emits one error per writer for cross-form kind disagreement", () => {
		// Two forms write to the same `(case_type, property_name)` tuple
		// with conflicting kinds. The spec contract: one error per
		// writer in the disagreeing set.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
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
									kind: "int",
									id: "weight",
									label: "Weight",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "decimal",
									id: "weight",
									label: "Weight",
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
						{ name: "weight", label: "Weight" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		const disagreeErrors = errors.filter(
			(e) => e.code === "FIELD_KIND_WRITERS_DISAGREE",
		);
		// Two writers — one int, one decimal — both must surface as
		// disagreeing. No `FIELD_KIND_PROPERTY_TYPE_MISMATCH` because the
		// property has no declared `data_type`.
		expect(disagreeErrors.length).toBe(2);
	});

	it("admits a fully-valid case-list-config without spurious cross-rule firings", () => {
		// All five module-scope rules + the app-scope rule must stay
		// silent on a structurally clean blueprint. The fixture exercises
		// every shape the rules pattern-match against (columns, sort,
		// calculated columns, filter absent, search inputs, multi-writer
		// agreement).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [
							{
								source: { kind: "property", property: "case_name" },
								type: "plain",
								direction: "asc",
							},
						],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("name_search", "Name", "text", {
								property: "case_name",
							}),
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
							],
						},
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
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
					properties: [{ name: "case_name", label: "Name", data_type: "text" }],
				},
			],
		});
		const errors = runValidation(doc);
		const newCodes = new Set([
			"CASE_LIST_COLUMN_UNKNOWN_FIELD",
			"CASE_LIST_FILTER_TYPE_ERROR",
			"CASE_LIST_SORT_UNKNOWN_PROPERTY",
			"CASE_LIST_SORT_UNKNOWN_CALCULATED_COLUMN",
			"CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
			"CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
			"FIELD_KIND_WRITERS_DISAGREE",
		]);
		expect(errors.filter((e) => newCodes.has(e.code))).toEqual([]);
	});
});
