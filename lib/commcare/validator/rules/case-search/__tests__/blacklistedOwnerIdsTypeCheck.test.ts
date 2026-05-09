/**
 * Tests for the `blacklistedOwnerIdsTypeCheck` rule. One invariant
 * per `it(...)` block.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn } from "@/lib/domain";
import { literal, prop, toValueExpression } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("blacklistedOwnerIdsTypeCheck", () => {
	it("fires when the expression references an unknown property", () => {
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
						dontClaimAlreadyOwned: false,
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
			(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Elm-style three-component message: identifies what was tried,
		// expected condition, what to look at to resolve.
		expect(hits[0].message).toContain("blacklisted owner ids");
		expect(hits[0].message).toContain("caseSearchConfig.blacklistedOwnerIds");
	});

	it("does not fire on a well-typed expression", () => {
		// A bare text literal is the canonical wire-shape — runtime
		// admits any text-coerceable value; the type checker accepts.
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
						dontClaimAlreadyOwned: false,
						blacklistedOwnerIds: toValueExpression(
							literal("user-1 user-2 user-3"),
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
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
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
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when the blacklistedOwnerIds slot is omitted", () => {
		// `caseSearchConfig` present but no `blacklistedOwnerIds` — the
		// wire layer omits the blacklist from the remote-request body.
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
					caseSearchConfig: { dontClaimAlreadyOwned: true },
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
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("admits a non-text-typed expression resolution (no expectedType lock)", () => {
		// The rule does NOT pin `expectedType: "text"`. A literal
		// of an int-typed property (date_opened / int field) flows
		// through `checkValueExpression` without a top-level
		// "expected text" mismatch; the wire layer coerces at
		// emission.
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
						dontClaimAlreadyOwned: false,
						// `prop("patient", "age")` resolves to int — admissible
						// because the rule doesn't lock the resolved type.
						blacklistedOwnerIds: { kind: "term", term: prop("patient", "age") },
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
									kind: "int",
									id: "age",
									label: "Age",
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
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			),
		).toBe(false);
	});
});
