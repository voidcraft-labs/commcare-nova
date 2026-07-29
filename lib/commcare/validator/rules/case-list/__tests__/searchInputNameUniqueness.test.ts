import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Tests for `searchInputNameUniqueness`. One invariant per `it` block.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { runValidation } from "../../../runner";

describe("searchInputNameUniqueness", () => {
	it("fires when two search inputs share a name and points at both rows", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-1")],
						detailColumnOrder: [testUuid("col-1")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-1"),
								"shared_name",
								"First",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								testUuid("si-2"),
								"shared_name",
								"Second",
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
									label: proseText("Name"),
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
		);
		expect(hits.length).toBe(1);
		// The message names the conflicting name + both 1-based indices so
		// the editor can highlight both rows.
		expect(hits[0].message).toContain('"shared_name"');
		expect(hits[0].message).toContain("input #1");
		expect(hits[0].message).toContain("input #2");
	});

	it("is silent when every name is unique", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-1")],
						detailColumnOrder: [testUuid("col-1")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-1"),
								"name_input",
								"Name",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								testUuid("si-2"),
								"age_input",
								"Age",
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
									label: proseText("Name"),
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
		);
		expect(hits).toHaveLength(0);
	});

	it("reports one error per duplicate (not a quadratic pair-set) when N>2", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-1")],
						detailColumnOrder: [testUuid("col-1")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-1"),
								"dup",
								"First",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								testUuid("si-2"),
								"dup",
								"Second",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								testUuid("si-3"),
								"dup",
								"Third",
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
									label: proseText("Name"),
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
		);
		// One error each for inputs #2 and #3 (both report against #1).
		expect(hits).toHaveLength(2);
	});

	it("is silent on zero or one search input", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-1"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-1")],
						detailColumnOrder: [testUuid("col-1")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-only"),
								"name_input",
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
									label: proseText("Name"),
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
		);
		expect(hits).toHaveLength(0);
	});
});
