/**
 * `mutationCommitVerdict` — the shared pre-dispatch gate every commit
 * surface (SA/MCP tool layer, builder dispatch hook) consults. These
 * tests pin the wiring, not the gate semantics themselves —
 * introduced-error diffing, phase handling, and identity stability are
 * `evaluateCommit`'s contract, proven in
 * `lib/commcare/validator/__tests__/gate.test.ts`. What must hold HERE:
 * the candidate doc comes from the same reducer a committed batch runs
 * through, the scope comes from `scopeOfMutations`, rejection carries
 * the introduced findings, and the prose renderer frames them
 * person-to-person.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { validationError } from "@/lib/commcare/validator/errors";
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";

/** Minimal valid doc: one registration module/form writing two properties. */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
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
								id: "village",
								label: "Village",
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
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

/** The minDoc form's uuid (single module, single form). */
function formUuid(doc: BlueprintDoc) {
	return doc.formOrder[doc.moduleOrder[0]][0];
}

describe("mutationCommitVerdict", () => {
	it("accepts a clean edit and returns the post-batch doc", () => {
		const doc = minDoc();
		const target = Object.values(doc.fields).find((fl) => fl.id === "village");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid as never,
				targetKind: "text",
				patch: { label: "Home village" },
			} as Mutation,
		];

		const verdict = mutationCommitVerdict(doc, mutations, "complete");
		expect(verdict.ok).toBe(true);
		const updated = Object.values(verdict.nextDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(updated && "label" in updated && updated.label).toBe("Home village");
	});

	it("rejects a soundness introduction in both phases, with the finding attached", () => {
		const doc = minDoc();
		const target = Object.values(doc.fields).find((fl) => fl.id === "village");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid as never,
				targetKind: "text",
				// An unparseable XPath — XPATH_SYNTAX, soundness class.
				// (`relevant`, not `calculate`: text fields carry no
				// `calculate` slot, so that patch key would be dropped by the
				// reducer's schema parse and nothing would be introduced.)
				patch: { relevant: "if(" },
			} as Mutation,
		];

		for (const phase of ["building", "complete"] as const) {
			const verdict = mutationCommitVerdict(doc, mutations, phase);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) {
				expect(verdict.introduced.length).toBeGreaterThan(0);
				expect(
					verdict.introduced.every((e) => typeof e.message === "string"),
				).toBe(true);
			}
		}
	});

	it("defers a completeness introduction while building, ratchets it when complete", () => {
		const doc = minDoc();
		const mutations: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: {
					uuid: asUuid("form-new"),
					id: "form_new",
					name: "Empty survey",
					type: "survey",
				} as never,
			},
		];

		// A scaffolded-but-unfilled form is unfinished, not wrong — passes
		// the construction window.
		expect(mutationCommitVerdict(doc, mutations, "building").ok).toBe(true);

		// The ratchet: a complete app may not gain an incomplete entity.
		const verdict = mutationCommitVerdict(doc, mutations, "complete");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain("EMPTY_FORM");
		}
	});

	it("tolerates a pre-existing error when the edit doesn't introduce a new one (legacy safety)", () => {
		// A doc that ALREADY carries an empty form (e.g. persisted before the
		// gates existed). Renaming the other form is a strict non-worsening
		// edit — it must pass even in complete phase.
		const base = minDoc();
		const broken = mutationCommitVerdict(
			base,
			[
				{
					kind: "addForm",
					moduleUuid: base.moduleOrder[0],
					form: {
						uuid: asUuid("form-old-empty"),
						id: "form_old_empty",
						name: "Old empty",
						type: "survey",
					} as never,
				},
			],
			"building",
		).nextDoc;

		const verdict = mutationCommitVerdict(
			broken,
			[{ kind: "renameForm", uuid: formUuid(broken), newId: "form_two" }],
			"complete",
		);
		expect(verdict.ok).toBe(true);
	});

	it("passes an empty batch through without validating", () => {
		const doc = minDoc();
		const verdict = mutationCommitVerdict(doc, [], "complete");
		expect(verdict).toEqual({ ok: true, nextDoc: doc });
		// Reference equality — no candidate apply ran.
		expect(verdict.nextDoc).toBe(doc);
	});
});

describe("describeIntroducedErrors", () => {
	it("frames the findings person-to-person, one line each, nothing-was-changed", () => {
		const message = describeIntroducedErrors([
			validationError("EMPTY_FORM", "form", '"Visit" has no fields.', {}),
			validationError(
				"NO_CASE_TYPE",
				"module",
				'Module "Mod" has case forms but no case_type.',
				{},
			),
		]);

		expect(message).toContain('- "Visit" has no fields.');
		expect(message).toContain(
			'- Module "Mod" has case forms but no case_type.',
		);
		expect(message).toContain("Nothing was changed.");
		// Never raw codes as the message.
		expect(message).not.toContain("EMPTY_FORM");
	});

	it("uses singular phrasing for one finding", () => {
		const message = describeIntroducedErrors([
			validationError("EMPTY_FORM", "form", '"Visit" has no fields.', {}),
		]);
		expect(message).toContain("a new problem");
		expect(message).toContain("this problem");
	});
});
