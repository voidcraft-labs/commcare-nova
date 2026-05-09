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
				(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("rejects a non-text-typed expression resolution (AST-strict expectedType: 'text')", () => {
		// The rule pins `expectedType: "text"` per the AST-strict
		// authoring contract — a `prop("patient", "age")` reference
		// resolves to `int`, which `typesCompatible(int, text)`
		// rejects. The author must coerce explicitly via
		// `concat(prop("patient", "age"))` to lift the int into
		// text.
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// The inner per-checker message names the expected type and the
		// resolved type — pin the string shape so a future change to
		// `describe()`'s output surfaces here, not silently downstream.
		expect(hits[0].message).toContain("Expected 'text'");
		expect(hits[0].message).toContain("resolves to 'int'");
	});

	it("admits a single_select / multi_select-typed expression (text-compatible)", () => {
		// `typesCompatible` widens `single_select` and `multi_select`
		// into `text`, so a select-typed property reference resolves
		// without needing explicit `concat(...)` coercion. Pin this
		// path so the rule's text-coercion contract stays load-
		// bearing through downstream changes.
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
						blacklistedOwnerIds: {
							kind: "term",
							term: prop("patient", "category"),
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
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{
							name: "category",
							label: "Category",
							data_type: "single_select",
						},
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
