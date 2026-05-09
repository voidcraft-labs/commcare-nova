/**
 * Tests for the `searchButtonDisplayConditionTypeCheck` rule. One
 * invariant per `it(...)` block; the rule routes through the shared
 * `moduleTypeContext` + `checkPredicate` dispatch every predicate-
 * slot rule uses, so the test pattern is the canonical shape:
 * fires-on-bad / passes-on-clean / short-circuits.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { eq, gt, input, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("searchButtonDisplayConditionTypeCheck", () => {
	it("fires when the display condition has an operand-type mismatch", () => {
		// `gt` against a `text` property — strings aren't ordered, so
		// the type checker rejects the comparison.
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
					caseSearchConfig: {
						searchButtonDisplayCondition: gt(
							prop("patient", "case_name"),
							literal("M"),
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
			(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Elm-style three-component message: identifies what was tried
		// (the display condition has a type error), forwards the inner
		// per-checker message, and threads the AST path so the editor
		// can land on the offending node.
		expect(hits[0].message).toContain('Module "Mod"');
		expect(hits[0].message).toContain("button display condition");
	});

	it("fires when the display condition references an unknown search input", () => {
		// Routes through `checkPredicate` with `knownInputs` populated
		// from the module's `searchInputs` — an orphan `input("ghost")`
		// surfaces as a `CheckError` and lifts here.
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
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							input("ghost"),
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
			(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
		);
		expect(
			hits.some((e) =>
				e.message.toLowerCase().includes("unknown search input"),
			),
		).toBe(true);
	});

	it("does not fire on a well-typed display condition", () => {
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
					caseSearchConfig: {
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							literal("Alice"),
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
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when `caseSearchConfig` is absent", () => {
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
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when the display condition slot is omitted", () => {
		// `caseSearchConfig` present but no `searchButtonDisplayCondition`
		// — the runtime renders the search button unconditionally, no
		// predicate to type-check.
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
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});
});
