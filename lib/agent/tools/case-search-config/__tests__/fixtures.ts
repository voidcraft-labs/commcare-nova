/**
 * Shared test fixtures for the case-search-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module into a canonical tool workspace. The fixture exposes
 * the resulting `{ doc, runTool, ... }` bundle so per-test bodies focus
 * on the tool's behavior rather than test-harness wiring.
 *
 * `makeCaseSearchMcpFixture` produces the parallel `McpContext`-hosted
 * shape for cross-surface tests asserting the same input produces the
 * same mutation batch on both surfaces.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "../../../__tests__/fixtures";
import { CanonicalMutationWorkspace } from "../../../workspace/canonicalWorkspace";

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

/** Bundle of the starting doc + a canonical workspace over a lightweight stub
 *  host for the per-tool tests (its `recordMutations` echoes the prepared
 *  candidate's doc as the committed doc; no Postgres, no guarded writer). */
export interface CaseSearchFixture extends ToolWorkspaceHarness {
	doc: BlueprintDoc;
}

/** Bundle of the starting doc + a canonical workspace hosted by the MCP
 *  `McpContext`, for cross-surface assertions. */
export interface CaseSearchMcpFixture extends MakeMcpTestContextHandles {
	doc: BlueprintDoc;
	workspace: CanonicalMutationWorkspace;
	runTool: ToolWorkspaceHarness["runTool"];
	currentDoc(): BlueprintDoc;
}

/**
 * Build a `{ doc, runTool, ... }` bundle for the chat surface — the
 * common shape every per-tool test boots from. A test that needs a
 * different starting document passes it in, so the workspace owns the
 * exact doc the tool will read.
 */
export function makeCaseSearchFixture(
	doc: BlueprintDoc = makeCaseSearchDoc(),
): CaseSearchFixture {
	return { ...makeToolWorkspaceHarness(doc), doc };
}

/**
 * Build a `{ doc, runTool, ... }` bundle for the MCP surface — used in
 * cross-surface parity tests that assert the same input produces
 * structurally-identical mutation batches.
 */
export function makeCaseSearchMcpFixture(
	doc: BlueprintDoc = makeCaseSearchDoc(),
): CaseSearchMcpFixture {
	const handles = makeMcpTestContext({ initialDoc: doc });
	const workspace = new CanonicalMutationWorkspace({
		host: handles.ctx,
		initialDoc: doc,
	});
	return {
		...handles,
		doc,
		workspace,
		runTool: (tool, input) =>
			workspace.invoke({
				toolName: "test-tool",
				execute: (ctx) => tool.execute(input as never, ctx),
			}),
		currentDoc: () => workspace.currentSnapshot().doc,
	};
}
