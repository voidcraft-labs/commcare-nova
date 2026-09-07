/**
 * Shared test fixtures for the case-list-config SA tools.
 *
 * Each tool test boots a minimal `BlueprintDoc` with one case-
 * carrying module + one followup form into a canonical tool
 * workspace. The fixture exposes the resulting `{ doc, runTool, ... }`
 * bundle so per-test bodies focus on the tool's behavior rather than
 * test-harness wiring.
 *
 */

import { expect } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../../__tests__/admittedFixture";
import {
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "../../../__tests__/fixtures";

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

/**
 * Build a `{ doc, runTool, ... }` bundle over a controlled host — the
 * common shape every per-tool test boots from. A test that needs a
 * different starting document passes it in, so the workspace owns the
 * exact doc the tool will read.
 */
export function makeCaseListFixture(
	doc: BlueprintDoc = makeCaseListDoc(),
): CaseListFixture {
	const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
	return {
		...h,
		doc,
		runTool: async (tool, input) => {
			const before = structuredClone(h.currentDoc());
			try {
				const outcome = await h.runTool(tool, input);
				if (
					typeof outcome === "object" &&
					outcome !== null &&
					"result" in outcome &&
					typeof outcome.result === "object" &&
					outcome.result !== null &&
					"error" in outcome.result
				) {
					expect(h.currentDoc()).toEqual(before);
				}
				return outcome;
			} catch (error) {
				expect(h.currentDoc()).toEqual(before);
				throw error;
			} finally {
				expectAdmittedDoc(h.currentDoc());
			}
		},
	};
}
