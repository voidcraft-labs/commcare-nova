/**
 * Tests for the `searchInputReferences` rule. One invariant per
 * `it(...)` block; each fixture exercises a distinct shape so a
 * regression can be localized to the relevant invariant.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { eq, input, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("searchInputReferences", () => {
	it("fires when `claimCondition` references an undeclared input name", () => {
		// `caseListConfig.searchInputs` declares `name_search`, but the
		// claim condition references `ghost_input` — orphan reference.
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
								asUuid("si-name"),
								"name_search",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
						claimCondition: eq(
							prop("patient", "case_name"),
							input("ghost_input"),
						),
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
		const errors = runValidation(doc);
		const hits = errors.filter(
			(e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
		);
		expect(hits.length).toBe(1);
		// Elm-style three-component shape: what was tried + went wrong,
		// expected condition, what to look at. Pin the orphan name and
		// the slot path so authors can locate the offending reference.
		expect(hits[0].message).toContain('"ghost_input"');
		expect(hits[0].message).toContain("caseSearchConfig.claimCondition");
		expect(hits[0].message).toContain("caseListConfig.searchInputs");
	});

	it("fires when `searchButtonDisplayCondition` references an undeclared input name", () => {
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
								asUuid("si-name"),
								"name_search",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							input("phantom_input"),
						),
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
		);
		expect(hits.length).toBe(1);
		expect(hits[0].message).toContain('"phantom_input"');
		expect(hits[0].message).toContain(
			"caseSearchConfig.searchButtonDisplayCondition",
		);
	});

	it("does not fire when every `input(...)` reference matches a declared name", () => {
		// `name_search` is declared on `caseListConfig.searchInputs` and
		// referenced via `input("name_search")` — clean resolution.
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
								asUuid("si-name"),
								"name_search",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
						claimCondition: eq(
							prop("patient", "case_name"),
							input("name_search"),
						),
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
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
			),
		).toBe(false);
	});

	it("short-circuits when `caseSearchConfig` is absent", () => {
		// No `caseSearchConfig` on the module — the rule has no
		// predicate to walk and emits nothing, even though
		// `caseListConfig.searchInputs` is empty (a plain case-list
		// module that doesn't declare any inputs).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
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
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
			),
		).toBe(false);
	});

	it("emits one error per orphan reference across both predicate slots", () => {
		// Two orphan refs — one in `claimCondition`, one in
		// `searchButtonDisplayCondition`. Each surfaces independently.
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
								asUuid("si-name"),
								"name_search",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						dontClaimAlreadyOwned: false,
						claimCondition: eq(
							prop("patient", "case_name"),
							input("orphan_one"),
						),
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							input("orphan_two"),
						),
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
		);
		expect(hits.length).toBe(2);
		expect(hits.some((e) => e.message.includes('"orphan_one"'))).toBe(true);
		expect(hits.some((e) => e.message.includes('"orphan_two"'))).toBe(true);
	});
});
