/**
 * Cross-rule integration tests for the case-search-config validator
 * surface. Two pins:
 *
 *   1. A blueprint that violates each of the four type-check rules
 *      surfaces every error simultaneously through `runValidation`.
 *   2. A structurally-clean blueprint exercising every covered slot
 *      (search-button display condition, excluded owner ids,
 *      simple-input default, advanced-input predicate, cross-walk
 *      filter reference) stays silent on every case-search-config
 *      rule.
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
	eq,
	gt,
	literal,
	prop,
	toValueExpression,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("case-search validator — cross-rule integration", () => {
	it("surfaces every case-search rule's error simultaneously when each violates", () => {
		// Single blueprint that structurally violates all four type-check codes:
		//
		//   1. searchButtonDisplayCondition: `eq` against unknown property
		//      → CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR
		//   2. excludedOwnerIds: ill-typed value (prop reference to
		//      unknown property)
		//      → CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR
		//   3. searchInputs[0].default: ill-typed value
		//      → CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR
		//   4. searchInputs[1] (advanced).predicate: ill-typed
		//      → CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						// Filter targets `region` (self-walk on patient) — same
						// destination as the simple-arm input below.
						filter: eq(prop("patient", "region"), literal("North")),
						searchInputs: [
							// Simple input sharing `(patient.region)` with the filter.
							// Default referencing an unknown property triggers the
							// per-input default type check.
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
								{ default: { kind: "term", term: prop("patient", "ghost") } },
							),
							// Advanced input with an ill-typed predicate (gt against
							// text-typed `case_name`).
							advancedSearchInputDef(
								asUuid("si-advanced"),
								"adv_input",
								"Advanced",
								"text",
								gt(prop("patient", "case_name"), literal("M")),
							),
						],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: eq(
							prop("patient", "phantom"),
							literal("x"),
						),
						excludedOwnerIds: {
							kind: "term",
							term: prop("patient", "phantom_property"),
						},
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
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
			),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
			),
		).toBe(true);
	});

	it("admits a fully-valid case-search-config + case-list-config without spurious firings", () => {
		// Structurally clean fixture exercising every covered slot:
		//
		//   - search-button display condition resolves
		//   - excluded owner ids expression resolves
		//   - simple-arm input default resolves (text literal matches
		//     the `text` widget's pinned expectedType)
		//   - advanced-arm input predicate resolves
		//   - the always-on filter and simple input intentionally narrow the
		//     same property; their intersection is valid runtime behavior
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
							// Simple input on patient's region (self-walk) with a
							// text-typed default — `text`-widget expectedType pins
							// to `text`, so a literal text seed type-checks cleanly.
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
								{ default: toValueExpression(literal("North")) },
							),
							// Advanced input with a well-typed predicate.
							advancedSearchInputDef(
								asUuid("si-advanced"),
								"adv_input",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), literal("Alice")),
							),
						],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							literal("Alice"),
						),
						excludedOwnerIds: toValueExpression(literal("user-123")),
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
		const errors = runValidation(doc);
		const caseSearchCodes = new Set([
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
		]);
		expect(errors.filter((e) => caseSearchCodes.has(e.code))).toEqual([]);
	});
});
