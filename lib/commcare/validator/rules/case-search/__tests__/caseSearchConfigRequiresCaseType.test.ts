import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `caseSearchConfigRequiresCaseType`. Fires when a module
 * carries a `caseSearchConfig` but has no `caseType`. CCHQ's
 * `<remote-request>` carries a mandatory `case_type` slot; without
 * one, the orchestrator throws at wire-emission time, and the HQ
 * JSON projection silently drops cross-walk simple inputs.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE" as const;

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
];

describe("caseSearchConfigRequiresCaseType", () => {
	it("fires when caseSearchConfig is present but the module has no caseType", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					// caseType intentionally omitted.
					caseListOnly: true,
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
					caseSearchConfig: {
						searchScreenTitle: "Find a patient",
					},
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("case search");
		expect(hits[0].message).toContain("caseType");
	});

	it("is silent when caseSearchConfig is present alongside a caseType", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListOnly: true,
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
					caseSearchConfig: {},
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});

	it("is silent when caseSearchConfig is absent (no `<remote-request>` to emit)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseListOnly: true,
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [],
					},
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});

	it("covers legacy markerless search inputs because they still emit a remote request", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Legacy search",
					caseListOnly: true,
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-legacy"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					// caseSearchConfig + caseType intentionally omitted: the
					// effective legacy projection supplies the former, not the latter.
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
	});
});
