/**
 * Shared test fixtures for the case-search-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module into a canonical tool workspace. The fixture exposes
 * the resulting `{ doc, runTool, ... }` bundle so per-test bodies focus
 * on the tool's behavior rather than test-harness wiring.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type CaseListFixture,
	makeCaseListFixture,
} from "../../case-list-config/__tests__/fixtures";

/* Stable uuid constant — imported by per-tool tests so each
 * assertion can reference the module by uuid against the post-
 * mutation doc. */
export const MOD_A = testUuid("11111111-1111-1111-1111-111111111111");

/**
 * Minimal `BlueprintDoc` with one `patient` case-carrying module. No
 * forms — the case-search-config tools operate at the module level
 * and don't read forms or fields. The case type carries one property
 * (`status`) so predicate-shape fixtures can target a real property
 * without inventing one in every test. The case list carries one
 * search input: a `caseSearchConfig` is only committable when the
 * search screen has something to fill in or a filter to apply
 * (the exact owner-only arm cannot carry Search action settings).
 */
export function makeCaseSearchDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
		caseListOnly: true,
		caseListConfig: resolveCaseListConfig({
			columns: [
				{
					uuid: testUuid("33333333-3333-3333-3333-333333333333"),
					kind: "plain",
					field: "case_name",
					header: "Name",
				},
			],
			searchInputs: [
				{
					uuid: testUuid("22222222-2222-2222-2222-222222222222"),
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		}),
	};
	return {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Full name") },
					{ name: "status", label: proseText("Status") },
				],
			},
		],
		modules: { [MOD_A]: mod },
		forms: {},
		fields: {},
		moduleOrder: [MOD_A],
		formOrder: { [MOD_A]: [] },
		fieldOrder: {},
		fieldParent: {},
	};
}

/** Actual input/document admission and canonical workspace, with a controlled
 * commit receipt. Persistence and native MCP transport belong to their suites. */
export function makeCaseSearchFixture(
	doc: BlueprintDoc = makeCaseSearchDoc(),
): CaseListFixture {
	return makeCaseListFixture(doc);
}
