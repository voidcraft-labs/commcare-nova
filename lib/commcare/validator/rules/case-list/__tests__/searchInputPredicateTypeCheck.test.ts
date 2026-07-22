import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for the `searchInputPredicateTypeCheck` rule. One invariant
 * per `it(...)` block; the rule's domain is the advanced-arm
 * `predicate` slot only.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, gt, input, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("searchInputPredicateTypeCheck", () => {
	it("fires when an advanced-arm predicate has an operand-type mismatch", () => {
		// `gt` against text-typed `case_name` — strings aren't ordered,
		// so the type checker rejects.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv_search",
								"Advanced",
								"text",
								gt(prop("patient", "case_name"), literal("M")),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Elm-style three-component message: identifies the input
		// by name + index, and threads the inner per-checker message.
		expect(hits[0].message).toContain('"adv_search"');
		expect(hits[0].message).toContain("predicate");
	});

	it("fires when an advanced-arm predicate references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv_search",
								"Advanced",
								"text",
								eq(prop("patient", "ghost"), literal("x")),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
		);
		expect(
			hits.some((e) => e.message.toLowerCase().includes("unknown property")),
		).toBe(true);
	});

	it("admits cross-input references via `knownInputs` resolution", () => {
		// An advanced predicate referencing another declared input
		// (`when-input-present(input("other"), ...)`) must resolve
		// because `moduleTypeContext` populates `knownInputs` from
		// the full `searchInputs` list. Pin the cross-input case
		// so the rule's `knownInputs` wiring stays load-bearing.
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
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv_search",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), input("name_search")),
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
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits simple-arm inputs (no authored predicate)", () => {
		// Simple-arm inputs derive their predicate from
		// `(property, mode, via)` at wire emission — no authored AST
		// to type-check. The rule must skip them silently.
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when the searchInputs list is empty", () => {
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
			),
		).toBe(false);
	});
});
