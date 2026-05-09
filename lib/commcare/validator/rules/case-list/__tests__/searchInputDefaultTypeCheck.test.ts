/**
 * Tests for the `searchInputDefaultTypeCheck` rule. One invariant
 * per `it(...)` block.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, prop, today } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("searchInputDefaultTypeCheck", () => {
	it("fires when a simple-arm input default references an unknown property", () => {
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
								asUuid("si-region"),
								"region_search",
								"Region",
								"text",
								"region",
								{
									default: {
										kind: "term",
										term: prop("patient", "phantom_property"),
									},
								},
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Elm-style three-component message: identifies the offending
		// input by name + index, and threads the inner per-checker
		// message.
		expect(hits[0].message).toContain('"region_search"');
		expect(hits[0].message).toContain("default value");
	});

	it("fires when an advanced-arm input default has a type error", () => {
		// The rule covers BOTH arms of the discriminated union — the
		// `default` slot is shared. Pin advanced-arm coverage explicitly.
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
								matchAll(),
								{
									default: {
										kind: "term",
										term: prop("patient", "phantom_property"),
									},
								},
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
		);
		expect(hits.some((e) => e.message.includes('"adv_search"'))).toBe(true);
	});

	it("fires when the resolved default type doesn't match the widget kind's expected type", () => {
		// AST-strict expectedType pin: a `text`-widget input rejects
		// a `today()` default because `today` resolves to `date` and
		// `typesCompatible(date, text)` is false. The author must
		// coerce explicitly via `concat(today())` (or pick a date
		// widget) for the seed to admit.
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
								asUuid("si-text"),
								"text_search",
								"Text",
								"text",
								"case_name",
								{ default: today() },
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		// Pin the inner-message shape so a future change to
		// `describe()`'s output surfaces here, not silently downstream.
		expect(hits[0].message).toContain("Expected 'text'");
		expect(hits[0].message).toContain("resolves to 'date'");
		expect(hits[0].message).toContain('widget "text"');
	});

	it("does not fire when a default is well-typed for the widget kind", () => {
		// `today()` resolves to `date` — matches the `date` widget's
		// pinned expectedType (`SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES.date`
		// → `"date"`). `typesCompatible(date, date)` holds, so the
		// seed admits without coercion.
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
								asUuid("si-date"),
								"date_search",
								"Date",
								"date",
								"date_opened",
								{ default: today() },
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
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("short-circuits per-input when the `default` slot is absent", () => {
		// No `default` on either input — the rule has nothing to check.
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
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("emits one error per input when multiple defaults are ill-typed", () => {
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
								asUuid("si-1"),
								"first",
								"First",
								"text",
								"case_name",
								{ default: { kind: "term", term: prop("patient", "ghost1") } },
							),
							simpleSearchInputDef(
								asUuid("si-2"),
								"second",
								"Second",
								"text",
								"case_name",
								{ default: { kind: "term", term: prop("patient", "ghost2") } },
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
		const hits = runValidation(doc).filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
		);
		// One error per offending input — both surface so the editor
		// can land on each independently.
		expect(hits.some((e) => e.message.includes('"first"'))).toBe(true);
		expect(hits.some((e) => e.message.includes('"second"'))).toBe(true);
	});
});
