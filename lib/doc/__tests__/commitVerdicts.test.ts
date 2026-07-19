/**
 * `mutationCommitVerdict` — the shared pre-dispatch gate every commit
 * surface (SA/MCP tool layer, builder dispatch hook) consults. These
 * tests pin the wiring, not the gate semantics themselves —
 * introduced-error diffing and identity stability are
 * `evaluateCommit`'s contract, proven in
 * `lib/commcare/validator/__tests__/gate.test.ts`. What must hold HERE:
 * the candidate doc comes from the same reducer a committed batch runs
 * through, the scope comes from `scopeOfMutations`, rejection carries
 * the introduced findings, and the prose renderer frames them
 * person-to-person.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
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

		const verdict = mutationCommitVerdict(doc, mutations);
		expect(verdict.ok).toBe(true);
		const updated = Object.values(verdict.nextDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(updated && "label" in updated && updated.label).toBe("Home village");
	});

	it("rejects removing the final Results field but allows empty Details", () => {
		const doc = minDoc();
		const moduleUuid = doc.moduleOrder[0];
		const column = doc.modules[moduleUuid].caseListConfig?.columns[0];
		if (!column) throw new Error("fixture must have a case-list column");

		const noResults = mutationCommitVerdict(doc, [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: column.uuid,
				column: { ...column, visibleInList: false },
				visibilityPatch: { surface: "list", visible: false },
			},
		]);
		expect(noResults.ok).toBe(false);
		if (!noResults.ok) {
			expect(noResults.introduced.map((finding) => finding.code)).toContain(
				"MISSING_CASE_LIST_COLUMNS",
			);
		}

		const noDetails = mutationCommitVerdict(doc, [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: column.uuid,
				column: { ...column, visibleInDetail: false },
				visibilityPatch: { surface: "detail", visible: false },
			},
		]);
		expect(noDetails.ok).toBe(true);
	});

	it("rejects a soundness introduction, with the finding attached", () => {
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
				patch: { relevant: xp("if(") },
			} as Mutation,
		];

		const verdict = mutationCommitVerdict(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.length).toBeGreaterThan(0);
			expect(
				verdict.introduced.every((e) => typeof e.message === "string"),
			).toBe(true);
		}
	});

	it("rejects a completeness introduction — an entity lands with what makes it complete", () => {
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

		const verdict = mutationCommitVerdict(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain("EMPTY_FORM");
		}
	});

	it("tolerates a pre-existing error when the edit doesn't introduce a new one (legacy safety)", () => {
		// A doc that ALREADY carries an empty form (e.g. persisted before the
		// gates existed). Renaming the other form is a strict non-worsening
		// edit — it must pass.
		const broken = buildDoc({
			appName: "Test legacy",
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
							],
						},
						// The pre-existing breakage: an empty survey form.
						{ name: "Old empty", type: "survey", fields: [] },
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});

		const verdict = mutationCommitVerdict(broken, [
			{ kind: "renameForm", uuid: formUuid(broken), newId: "form_two" },
		]);
		expect(verdict.ok).toBe(true);
	});

	it("passes an empty batch through without validating", () => {
		const doc = minDoc();
		const verdict = mutationCommitVerdict(doc, []);
		expect(verdict).toEqual({ ok: true, nextDoc: doc, results: [] });
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

// ── Stored-reference bounces — the repair the prose must name ────────

describe("stored-reference bounce prose", () => {
	/** minDoc plus a hidden total whose calculate references `village`.
	 *  `raw` keeps the reference as plain text (the never-re-resolved
	 *  legacy shape); otherwise it resolves to an identity leaf — the two
	 *  storage shapes whose bounces need different repairs. */
	function docWithReference(raw: boolean): BlueprintDoc {
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
								f({
									kind: "hidden",
									id: "total",
									calculate: raw ? xp("#form/village") : "#form/village",
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

	it("rename bounce on a plain-text leaf names the carrier and the re-commit repair", () => {
		const doc = docWithReference(true);
		// Valid as it stands — the raw leaf's target exists.
		expect(mutationCommitVerdict(doc, []).ok).toBe(true);
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "renameField", uuid: village?.uuid as never, newId: "town" },
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		const message = describeIntroducedErrors(verdict.introduced);
		// The repair is performable: the carrier expression is named, and
		// the user is told to re-commit it before the rename can land.
		expect(message).toContain('Field "total"');
		expect(message).toContain("calculated value");
		expect(message).toContain("plain text");
		expect(message).toContain("re-commit");
	});

	it("delete bounce on an identity reference names the carrier, never the bare uuid", () => {
		const doc = docWithReference(false);
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "removeField", uuid: village?.uuid as never },
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		const message = describeIntroducedErrors(verdict.introduced);
		expect(message).toContain('Field "total"');
		expect(message).toContain("calculated value");
		expect(message).toContain("no longer exists");
		// The dangling leaf prints as the target's uuid — an internal id,
		// not a path anyone can find — so it must not reach the prose.
		expect(message).not.toContain(village?.uuid as string);
	});

	it("a same-batch rename of a resolved reference still lands (identity needs no repair)", () => {
		const doc = docWithReference(false);
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "renameField", uuid: village?.uuid as never, newId: "town" },
		]);
		// The identity leaf re-prints under the new name — nothing dangles.
		expect(verdict.ok).toBe(true);
	});
});
