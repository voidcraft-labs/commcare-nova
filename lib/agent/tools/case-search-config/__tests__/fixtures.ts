/**
 * Shared test fixtures for the case-search-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module against the fixture's `GenerationContext` shim. The
 * fixture exposes the resulting `{ doc, ctx }` pair so per-test bodies
 * focus on the tool's behavior rather than test-harness wiring.
 *
 * `makeCaseSearchMcpFixture` produces the parallel `McpContext`-driven
 * shape for cross-surface tests asserting the same input produces the
 * same mutation batch on both surfaces.
 */

import { asUuid, type BlueprintDoc, type Module } from "@/lib/domain";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeStubToolContext,
	type StubToolContextHandles,
} from "../../../__tests__/fixtures";

/* Stable uuid constant — imported by per-tool tests so each
 * assertion can reference the module by uuid against the post-
 * mutation doc. */
export const MOD_A = asUuid("11111111-1111-1111-1111-111111111111");

/**
 * Minimal `BlueprintDoc` with one `patient` case-carrying module. No
 * forms — the case-search-config tools operate at the module level
 * and don't read forms or fields. The case type carries one property
 * (`status`) so predicate-shape fixtures can target a real property
 * without inventing one in every test. The case list carries one
 * search input: a `caseSearchConfig` is only committable when the
 * search screen has something to fill in or a filter to apply
 * (CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE gates the bare state).
 */
export function makeCaseSearchDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
		caseListConfig: {
			columns: [],
			searchInputs: [
				{
					uuid: asUuid("22222222-2222-2222-2222-222222222222"),
					kind: "simple",
					name: "name_search",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		},
	};
	return {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Full name" },
					{ name: "status", label: "Status" },
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

/** Bundle of doc + a lightweight chat-surface `ToolExecutionContext` stub for
 *  the per-tool tests (its `recordMutations` echoes the passed post-mutation
 *  doc as the committed doc; no Postgres, no guarded writer). */
export interface CaseSearchFixture extends StubToolContextHandles {
	doc: BlueprintDoc;
}

/** Bundle of doc + MCP `McpContext` for cross-surface assertions. */
export interface CaseSearchMcpFixture extends MakeMcpTestContextHandles {
	doc: BlueprintDoc;
}

/**
 * Build a `{ doc, ctx, ... }` bundle for the chat surface — the
 * common shape every per-tool test boots from.
 */
export function makeCaseSearchFixture(): CaseSearchFixture {
	const handles = makeStubToolContext();
	return { ...handles, doc: makeCaseSearchDoc() };
}

/**
 * Build a `{ doc, ctx, ... }` bundle for the MCP surface — used in
 * cross-surface parity tests that assert the same input produces
 * structurally-identical mutation batches.
 */
export function makeCaseSearchMcpFixture(): CaseSearchMcpFixture {
	const handles = makeMcpTestContext();
	return { ...handles, doc: makeCaseSearchDoc() };
}
