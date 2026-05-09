/**
 * Cross-rule integration tests for the case-search-config validator
 * surface. Two pins: a single blueprint can simultaneously trigger
 * all three rules (orphan input ref + claim-condition type error +
 * filter/input property conflict); a structurally clean blueprint
 * stays silent across every case-search rule.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { eq, gt, input, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("case-search validator — cross-rule integration", () => {
	it("surfaces all three errors on the same blueprint", () => {
		// Blueprint structurally violates each rule:
		//
		//   1. claim condition references `ghost_input` (orphan ref)
		//   2. claim condition uses `gt` against a `text` property —
		//      strings aren't ordered, so the type checker rejects it
		//   3. filter and a simple-arm input both target `region`,
		//      AND-composition conflict at the wire layer
		//
		// Each rule fires independently — the validator emits one
		// error per pinned invariant.
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
						claimCondition: {
							kind: "and",
							clauses: [
								// Type error — `gt` on text-typed `case_name`.
								gt(prop("patient", "case_name"), literal("M")),
								// Orphan input ref — `ghost_input` isn't declared.
								eq(prop("patient", "case_name"), input("ghost_input")),
							],
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
			errors.some((e) => e.code === "CASE_SEARCH_INPUT_REFERENCE_UNKNOWN"),
		).toBe(true);
		expect(
			errors.some((e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR"),
		).toBe(true);
		expect(
			errors.some((e) => e.code === "CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT"),
		).toBe(true);
	});

	it("admits a fully-valid case-search-config without spurious cross-rule firings", () => {
		// Structurally clean fixture — every rule should stay silent:
		//
		//   - declared input names match every `input(...)` reference
		//   - claim condition type-checks against the augmented case-
		//     type list
		//   - filter and search inputs target disjoint properties
		//
		// Pins all three case-search codes against the no-emit
		// expectation simultaneously.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						// Filter targets `status`; inputs target `region` —
						// disjoint property sets, no conflict.
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
						claimCondition: eq(
							prop("patient", "case_name"),
							input("region_search"),
						),
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
		const errors = runValidation(doc);
		const caseSearchCodes = new Set([
			"CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
			"CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			"CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		]);
		expect(errors.filter((e) => caseSearchCodes.has(e.code))).toEqual([]);
	});
});
