import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `searchInputSelectWidgetNotSupported`. The rule rejects
 * simple-arm search inputs with `type: "select"` until Nova's prompt
 * emitter learns to write the `<itemset>` child CCHQ-core requires
 * to render the widget as a select. Without `<itemset>`,
 * `QueryPrompt.isSelect()` returns false and the runtime renders the
 * prompt as a plain text input — silent UX regression.
 *
 * Advanced-arm inputs are not gated: the advanced predicate
 * composes the membership check explicitly and does not depend on
 * the runtime select widget.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED" as const;

describe("searchInputSelectWidgetNotSupported", () => {
	it("fires when a simple-arm input uses type=`select`", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"status_q",
								"Status",
								"select",
								"status",
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
						{ name: "status", label: "Status", data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("`select` widget type");
		expect(hits[0].message).toContain("status_q");
		expect(hits[0].location.moduleName).toBe("Mod");
	});

	it("is silent on advanced-arm inputs (the predicate composes the membership check)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-1"),
								"status_q",
								"Status",
								"select",
								{ kind: "match-all" },
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
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});

	it("is silent when the simple-arm input uses a supported widget type (e.g. text)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"name_q",
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});

	it("fires once per offending simple-arm input when multiple are present", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"status_q",
								"Status",
								"select",
								"status",
							),
							simpleSearchInputDef(
								asUuid("si-2"),
								"region_q",
								"Region",
								"select",
								"region",
							),
							simpleSearchInputDef(
								asUuid("si-3"),
								"name_q",
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
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "status", label: "Status", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(2);
		const offenders = hits.map((h) => h.details?.inputName).sort();
		expect(offenders).toEqual(["region_q", "status_q"]);
	});

	it("short-circuits when `caseListConfig` is absent", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
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
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});
});
