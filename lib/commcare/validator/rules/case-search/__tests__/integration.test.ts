/**
 * Cross-rule integration tests for the case-search-config validator
 * surface. Two pins:
 *
 *   1. A blueprint that violates each of the five new type-check
 *      rules + the `filter / simple-input` conflict rule surfaces
 *      every error simultaneously through `runValidation`.
 *   2. A structurally-clean blueprint exercising every covered
 *      slot (claim condition, search-button display condition,
 *      blacklisted owner ids, simple-input default, advanced-input
 *      predicate, advanced-input default, cross-walk filter
 *      reference) stays silent on every case-search-config rule.
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
	gt,
	input,
	literal,
	prop,
	relationStep,
	toValueExpression,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("case-search validator — cross-rule integration", () => {
	it("surfaces every case-search rule's error simultaneously when each violates", () => {
		// Single blueprint that structurally violates all six rules:
		//
		//   1. claimCondition: `gt` on text-typed `case_name`
		//      → CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR
		//   2. searchButtonDisplayCondition: `eq` against unknown property
		//      → CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR
		//   3. blacklistedOwnerIds: ill-typed value (prop reference to
		//      unknown property)
		//      → CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR
		//   4. searchInputs[0].default: ill-typed value
		//      → CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR
		//   5. searchInputs[1] (advanced).predicate: ill-typed
		//      → CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR
		//   6. filter + simple-arm input target same `(patient.region)`
		//      runtime path → CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT
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
							// Default is ill-typed (`gt` predicate result fed as a
							// value would be ill-formed; use a comparison-shaped
							// expression that resolves wrong instead — pass a literal
							// pretending to be of an incompatible type via `prop` to
							// an unknown property).
							simpleSearchInputDef(
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
								// Default referencing an unknown property triggers the
								// per-input default type check.
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
						dontClaimAlreadyOwned: false,
						claimCondition: gt(prop("patient", "case_name"), literal("M")),
						searchButtonDisplayCondition: eq(
							prop("patient", "phantom"),
							literal("x"),
						),
						blacklistedOwnerIds: {
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
			errors.some((e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR"),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(true);
		expect(
			errors.some(
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
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
		expect(
			errors.some((e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT"),
		).toBe(true);
	});

	it("admits a fully-valid case-search-config + case-list-config without spurious firings", () => {
		// Structurally clean fixture exercising every covered slot:
		//
		//   - claim condition resolves against augmented case types
		//   - search-button display condition resolves
		//   - blacklisted owner ids expression resolves
		//   - simple-arm input default resolves (text literal matches
		//     the `text` widget's pinned expectedType)
		//   - advanced-arm input predicate resolves
		//   - cross-walk filter ref → distinct destination (parent's
		//     `region`) from the simple input (patient's `region`),
		//     so the conflict rule's via-aware dedup admits the pair
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						// Filter walks via `parent` to `household.region` — distinct
						// runtime path from the simple input's `(patient.region)`.
						filter: eq(
							prop(
								"patient",
								"region",
								ancestorPath(relationStep("parent", "household")),
							),
							literal("North"),
						),
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
						dontClaimAlreadyOwned: false,
						claimCondition: eq(
							prop("patient", "case_name"),
							input("region_search"),
						),
						searchButtonDisplayCondition: eq(
							prop("patient", "case_name"),
							literal("Alice"),
						),
						blacklistedOwnerIds: toValueExpression(literal("user-123")),
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
		const errors = runValidation(doc);
		const caseSearchCodes = new Set([
			"CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			"CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
			"CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		]);
		expect(errors.filter((e) => caseSearchCodes.has(e.code))).toEqual([]);
	});
});
