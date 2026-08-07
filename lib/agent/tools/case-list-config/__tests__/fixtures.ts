/**
 * Shared test fixtures for the case-list-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module + one followup form into a canonical tool
 * workspace. The fixture exposes the resulting `{ doc, runTool, ... }`
 * bundle so per-test bodies focus on the tool's behavior rather than
 * test-harness wiring.
 *
 * `makeCaseListMcpFixture` produces the parallel `McpContext`-hosted
 * shape for cross-surface tests that assert the same input produces
 * the same mutation batch on both surfaces.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "../../../__tests__/fixtures";
import { CanonicalMutationWorkspace } from "../../../workspace/canonicalWorkspace";

/* Stable uuid constants — imported by the per-tool tests so each
 * assertion can reference the module / form by uuid against the
 * post-mutation doc. */
export const MOD_A = testUuid("11111111-1111-1111-1111-111111111111");
export const FORM_A = testUuid("33333333-3333-3333-3333-333333333333");
export const FIELD_A = testUuid("55555555-5555-4555-8555-555555555555");
export const BASE_COLUMN = testUuid("case-list-fixture-base-column");

/**
 * Minimal `BlueprintDoc` with one `patient` case-carrying module
 * + one registration form. The case type declares every property the
 * per-tool tests reference (columns, filters, and search inputs must
 * name declared case properties or the commit gate rejects the batch —
 * the same admission set `caseRefAcceptMap` reads), so the fixtures
 * exercise tool behavior with valid authoring inputs.
 */
export function makeCaseListDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
		caseListConfig: {
			columns: [
				plainColumn(BASE_COLUMN, "case_name", "Patient", {
					visibleInDetail: true,
					visibleInList: true,
				}),
			],
			listColumnOrder: [BASE_COLUMN],
			detailColumnOrder: [BASE_COLUMN],
			searchInputs: [],
		},
	};
	const form: Form = {
		uuid: FORM_A,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
	const field: Field = {
		uuid: FIELD_A,
		id: "case_name",
		kind: "text",
		label: proseText("Full name"),
		caseWrite: { caseType: "patient", property: "case_name" },
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
					{ name: "full_name", label: proseText("Name") },
					{ name: "phone", label: proseText("Phone") },
					{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
					{
						name: "last_visit",
						label: proseText("Last visit"),
						data_type: "date",
					},
					{ name: "region_code", label: proseText("Region code") },
					{ name: "region", label: proseText("Region") },
					{ name: "status", label: proseText("Status") },
					{ name: "alpha", label: proseText("Alpha") },
					{ name: "beta", label: proseText("Beta") },
					{ name: "charlie", label: proseText("Charlie") },
					{ name: "existing", label: proseText("Existing") },
					{ name: "first", label: proseText("First") },
					{ name: "second", label: proseText("Second") },
				],
			},
		],
		modules: { [MOD_A]: mod },
		forms: { [FORM_A]: form },
		fields: { [FIELD_A]: field },
		moduleOrder: [MOD_A],
		formOrder: { [MOD_A]: [FORM_A] },
		fieldOrder: { [FORM_A]: [FIELD_A] },
		fieldParent: { [FIELD_A]: FORM_A },
	};
}

/** Bundle of the starting doc + a canonical workspace over a lightweight stub
 *  host for the per-tool tests (its `recordMutations` echoes the prepared
 *  candidate's doc as the committed doc — no Postgres, no guarded writer). */
export interface CaseListFixture extends ToolWorkspaceHarness {
	doc: BlueprintDoc;
}

/** Bundle of the starting doc + a canonical workspace hosted by the MCP
 *  `McpContext`, for cross-surface assertions. */
export interface CaseListMcpFixture extends MakeMcpTestContextHandles {
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
export function makeCaseListFixture(
	doc: BlueprintDoc = makeCaseListDoc(),
): CaseListFixture {
	return { ...makeToolWorkspaceHarness(doc), doc };
}

/**
 * Build a `{ doc, runTool, ... }` bundle for the MCP surface — used in
 * cross-surface parity tests that assert the same input produces
 * structurally-identical mutation batches.
 */
export function makeCaseListMcpFixture(
	doc: BlueprintDoc = makeCaseListDoc(),
): CaseListMcpFixture {
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
