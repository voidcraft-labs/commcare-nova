/**
 * Shared test fixtures for the case-list-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module + one followup form against the fixture's
 * `GenerationContext` shim. The fixture exposes the resulting
 * `{ doc, ctx }` pair so per-test bodies focus on the tool's
 * behavior rather than test-harness wiring.
 *
 * `makeMcpFixture` produces the parallel `McpContext`-driven shape
 * for cross-surface tests that assert the same input produces the
 * same mutation batch on both surfaces.
 */

import {
	asUuid,
	type BlueprintDoc,
	type Form,
	type Module,
} from "@/lib/domain";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeTestContext,
	type TestContextHandles,
} from "../../../__tests__/fixtures";

/* Stable uuid constants — imported by the per-tool tests so each
 * assertion can reference the module / form by uuid against the
 * post-mutation doc. */
export const MOD_A = asUuid("11111111-1111-1111-1111-111111111111");
export const FORM_A = asUuid("33333333-3333-3333-3333-333333333333");

/**
 * Minimal `BlueprintDoc` with one `patient` case-carrying module
 * + one registration form. The case type carries one property
 * (`case_name`) so predicate-shape fixtures can target a real
 * property without inventing one in every test.
 */
export function makeCaseListDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
	};
	const form: Form = {
		uuid: FORM_A,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
	return {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Full name" }],
			},
		],
		modules: { [MOD_A]: mod },
		forms: { [FORM_A]: form },
		fields: {},
		moduleOrder: [MOD_A],
		formOrder: { [MOD_A]: [FORM_A] },
		fieldOrder: {},
		fieldParent: {},
	};
}

/** Bundle of doc + chat-side `GenerationContext` for the per-tool tests. */
export interface CaseListFixture extends TestContextHandles {
	doc: BlueprintDoc;
}

/** Bundle of doc + MCP `McpContext` for cross-surface assertions. */
export interface CaseListMcpFixture extends MakeMcpTestContextHandles {
	doc: BlueprintDoc;
}

/**
 * Build a `{ doc, ctx, ... }` bundle for the chat surface — the
 * common shape every per-tool test boots from.
 */
export function makeCaseListFixture(): CaseListFixture {
	const handles = makeTestContext();
	return { ...handles, doc: makeCaseListDoc() };
}

/**
 * Build a `{ doc, ctx, ... }` bundle for the MCP surface — used in
 * cross-surface parity tests that assert the same input produces
 * structurally-identical mutation batches.
 */
export function makeCaseListMcpFixture(): CaseListMcpFixture {
	const handles = makeMcpTestContext();
	return { ...handles, doc: makeCaseListDoc() };
}
