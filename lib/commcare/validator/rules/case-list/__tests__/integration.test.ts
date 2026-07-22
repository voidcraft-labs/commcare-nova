import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
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
import {
	asUuid,
	calculatedColumn,
	dateColumn,
	idMappingEntry,
	imageMapEntry,
	plainColumn,
	rangeMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import { arith, input, prop, term } from "@/lib/domain/predicate";
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-name-range"),
								"name_range",
								"Name range",
								"text",
								"name",
								{ mode: rangeMode() },
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
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
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
		// with conflicting kinds. The contract is one error per
		// writer in the disagreeing set so each form names itself
		// in the validator output.
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
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const disagreeErrors = errors.filter(
			(e) => e.code === "FIELD_KIND_WRITERS_DISAGREE",
		);
		// Two writers — one int, one decimal — both must surface as
		// disagreeing. No `FIELD_KIND_PROPERTY_TYPE_MISMATCH` because the
		// property has no declared `data_type`.
		expect(disagreeErrors.length).toBe(2);
	});

	it("admits a fully-valid case-list-config without spurious cross-rule firings", () => {
		// All four module-scope case-list rules + the app-scope rule
		// must stay silent on a structurally clean blueprint. The
		// fixture exercises every shape the rules pattern-match
		// against (columns, calculated columns absent, filter absent,
		// simple search inputs, multi-writer agreement).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name", {
								sort: { direction: "asc", priority: 0 },
							}),
						],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-name-search"),
								"name_search",
								"Name",
								"text",
								"case_name",
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
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const newCodes = new Set([
			"CASE_LIST_COLUMN_UNKNOWN_FIELD",
			"CASE_LIST_FILTER_TYPE_ERROR",
			"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
			"CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
			"FIELD_KIND_WRITERS_DISAGREE",
		]);
		expect(errors.filter((e) => newCodes.has(e.code))).toEqual([]);
	});

	it("ignores malformed legacy columns that have no running-app role", () => {
		const dormant = {
			visibleInList: false,
			visibleInDetail: false,
		} as const;
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							plainColumn(
								asUuid("col-unknown"),
								"missing_property",
								"Old field",
								dormant,
							),
							dateColumn(
								asUuid("col-wrong-kind"),
								"case_name",
								"Old date",
								"%Y-%m-%d",
								dormant,
							),
							calculatedColumn(
								asUuid("col-bad-calc"),
								"Old calculation",
								arith(
									"+",
									term(prop("patient", "case_name")),
									term(prop("patient", "case_name")),
								),
								dormant,
							),
							calculatedColumn(
								asUuid("col-bare-input"),
								"Old input calculation",
								term(input("missing_search_input")),
								dormant,
							),
							{
								kind: "id-mapping",
								uuid: asUuid("col-bad-map"),
								field: "case_name",
								header: "Old labels",
								mapping: [idMappingEntry("", "Blank")],
								...dormant,
							},
							{
								kind: "image-map",
								uuid: asUuid("col-bad-images"),
								field: "case_name",
								header: "Old images",
								mapping: [
									imageMapEntry("same", "missing-image-a"),
									imageMapEntry("same", "missing-image-b"),
								],
								...dormant,
							},
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Registration",
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

		const dormantColumnCodes = new Set([
			"CASE_LIST_COLUMN_UNKNOWN_FIELD",
			"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
			"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			"CASE_LIST_BARE_SEARCH_INPUT_REF",
			"CASE_LIST_ID_MAPPING_EMPTY_VALUE",
			"CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE",
			"MEDIA_ASSET_NOT_FOUND",
		]);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => dormantColumnCodes.has(error.code)),
		).toEqual([]);
	});
});
