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

import { proseText } from "@/lib/domain/prose";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Form, Module } from "@/lib/domain";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeStubToolContext,
	type StubToolContextHandles,
} from "../../../__tests__/fixtures";

/* Stable uuid constants — imported by the per-tool tests so each
 * assertion can reference the module / form by uuid against the
 * post-mutation doc. */
export const MOD_A = testUuid("11111111-1111-1111-1111-111111111111");
export const FORM_A = testUuid("33333333-3333-3333-3333-333333333333");

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
				properties: [
					{ name: "case_name", label: proseText("Full name") },
					{ name: "name", label: proseText("Name") },
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
				],
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

/** Bundle of doc + a lightweight chat-surface `ToolExecutionContext` stub for
 *  the per-tool tests (its `recordMutations` echoes the passed post-mutation
 *  doc as the committed doc — no Postgres, no guarded writer). */
export interface CaseListFixture extends StubToolContextHandles {
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
	const handles = makeStubToolContext();
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
