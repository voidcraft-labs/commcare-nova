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
	it("fires the case-data code when a simple-arm default reads a case property", () => {
		// The search screen opens before any case is selected, so a
		// property read in a seed has no row to read — it resolves blank
		// on every runtime. The case-data guard intercepts BEFORE the
		// type check, so the type-error code stays silent for the same
		// expression.
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
										term: prop("patient", "region"),
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
		const results = runValidation(doc);
		const hits = results.filter(
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"region_search"');
		expect(hits[0].message).toContain("before any case is selected");
		expect(hits[0].details).toMatchObject({
			inputName: "region_search",
			inputUuid: asUuid("si-region"),
		});
		expect(
			results.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("fires the case-data code when an advanced-arm default reads a case property", () => {
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
										term: prop("patient", "case_name"),
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
			(e) => e.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
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

	it("rejects a legacy scalar default on a date-range input with one repair", () => {
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
								asUuid("si-range"),
								"visit_window",
								"Visit window",
								"date-range",
								"visit_date",
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
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "visit_date", label: "Visit", data_type: "date" },
					],
				},
			],
		});

		const hits = runValidation(doc).filter(
			(error) => error.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputName: "visit_window",
			reason: "date-range-default-unsupported",
		});
		expect(hits[0].message).toContain("needs both a start and an end");
		expect(hits[0].message).toContain("Remove the starting value");
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
		// Two `text` widgets each seeded with `today()` (resolves `date`,
		// incompatible with the widget's pinned `text` expectation) — the
		// non-case-data ill-typed shape, so the plain type-error path is
		// what fires, once per offending input.
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
								{ default: today() },
							),
							simpleSearchInputDef(
								asUuid("si-2"),
								"second",
								"Second",
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
		// One error per offending input — both surface so the editor
		// can land on each independently.
		expect(hits.some((e) => e.message.includes('"first"'))).toBe(true);
		expect(hits.some((e) => e.message.includes('"second"'))).toBe(true);
	});
});
