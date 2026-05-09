/**
 * Tests for the `claimConditionTypeCheck` rule. One invariant per
 * `it(...)` block; mirrors the case-list `filterTypeCheck` test
 * pattern so the two rules stay structurally aligned.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn } from "@/lib/domain";
import { eq, gt, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("claimConditionTypeCheck", () => {
	it("fires when the claim condition has an operand-type mismatch", () => {
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
						claimCondition: gt(prop("patient", "case_name"), literal("M")),
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
			(e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Elm-style three-component message: identifies what was tried
		// (the claim condition has a type error), the per-checker
		// expected condition (forwarded as the inner message), and the
		// AST path so the editor can land on the offending node.
		expect(hits[0].message).toContain('Module "Mod"');
		expect(hits[0].message).toContain("claim condition");
	});

	it("fires when the claim condition references an unknown property", () => {
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
						claimCondition: eq(prop("patient", "ghost"), literal("x")),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
		);
		expect(
			hits.some((e) => e.message.toLowerCase().includes("unknown property")),
		).toBe(true);
	});

	it("does not fire on a well-typed claim condition", () => {
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
						// `eq(text-prop, text-literal)` — structurally compatible.
						claimCondition: eq(prop("patient", "case_name"), literal("Alice")),
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
				(e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when `caseSearchConfig` is absent", () => {
		// Even with a structurally-broken predicate floating around as a
		// detached AST, the rule shouldn't fire — `caseSearchConfig`
		// itself is absent, so no `<remote-request>` is emitted and the
		// claim flow doesn't exist on the module.
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
				(e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits when `claimCondition` is omitted but `caseSearchConfig` is present", () => {
		// Module emits `<remote-request>` (caseSearchConfig present)
		// but doesn't gate the claim — runtime claims unconditionally.
		// No predicate to type-check, so the rule emits nothing.
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
				(e) => e.code === "CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			),
		).toBe(false);
	});
});
