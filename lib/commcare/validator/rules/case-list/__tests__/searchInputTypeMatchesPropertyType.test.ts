import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `searchInputTypeMatchesPropertyType`. The rule gates a
 * simple-arm search input's WIDGET kind against the destination
 * property's `data_type` — orthogonal to the mode-vs-data-type rule.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH" as const;

describe("searchInputTypeMatchesPropertyType", () => {
	it("fires when a date widget targets a text property", () => {
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
								"date",
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"date" widget');
		expect(hits[0].message).toContain("case_name");
	});

	it("fires when a barcode widget targets an int property", () => {
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
								"age_q",
								"Age",
								"barcode",
								"age",
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
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("admits text widget against every property type (admit-list is undefined)", () => {
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
								"age_q",
								"Age",
								"text",
								"age",
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
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent on advanced-arm inputs (their predicate may compose multi-typed properties)", () => {
		// Validator's predicate-type-check rule handles advanced-arm
		// property references; this rule has no single (widget, property)
		// gate to apply to the advanced shape.
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
								name: "adv",
								label: "Advanced",
								type: "date",
								predicate: { kind: "match-all" },
							},
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
