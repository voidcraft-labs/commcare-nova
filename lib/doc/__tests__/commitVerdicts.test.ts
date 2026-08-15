import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * `mutationCommitVerdict` — the shared pre-dispatch gate every commit
 * surface (SA/MCP tool layer, builder dispatch hook) consults. These
 * tests pin the wiring, not the gate semantics themselves —
 * whole-candidate validation is `evaluateCommit`'s contract, proven in
 * `lib/commcare/validator/__tests__/gate.test.ts`. What must hold HERE:
 * the candidate doc comes from the same reducer a committed batch runs
 * through, every candidate (including an empty batch) passes the absolute
 * gate, rejection carries every gating finding, and the prose renderer
 * frames them person-to-person.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { validationError } from "@/lib/commcare/validator/errors";
import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { parseXPathForField } from "@/lib/doc/expressionText";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

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
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
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
		if (!target) throw new Error("fixture must have a village field");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target.uuid,
				targetKind: "text",
				patch: { label: proseText("Home village") },
			},
		];

		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		const updated = Object.values(verdict.nextDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(updated && "label" in updated && updated.label).toEqual(
			proseText("Home village"),
		);
	});

	it("accepts a case-ref expression whose object keys admission re-sorts", () => {
		// Admission (`admitMutationBatch`) re-serializes every mutation with
		// sorted object keys, and `case-ref` is the one XPath part whose
		// sorted spelling ({caseType, kind, property}) differs from its
		// authored spelling ({kind, caseType, property}). The candidate doc
		// therefore stores the sorted shape, and the deep validator's
		// parse-and-print round trip must compare ASTs structurally rather
		// than byte-wise. Regression: a live build rejected every faithful
		// construction of a case-reading guard as INVALID_REF.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Households",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Update",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "village",
									label: proseText("Village"),
									caseWrite: { caseType: "patient", property: "village" },
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
					],
				},
			],
		});
		const caseRead = xp("#patient/village");
		expect(caseRead.parts).toEqual([
			{ kind: "case-ref", caseType: "patient", property: "village" },
		]);

		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "addField",
					parentUuid: formUuid(doc),
					field: {
						uuid: testUuid("case-ref-hidden"),
						kind: "hidden",
						id: "village_value",
						calculate: caseRead,
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});

	it("accepts case-ref prose whose object keys admission re-sorts", () => {
		// A record-summary label is the prose twin of the XPath regression above.
		// Admission sorts the case-ref's keys, while the TipTap codec parses the
		// same semantic part back in schema order. Key order cannot make a valid
		// direct case read fail and force an author to mirror it through hidden
		// calculated fields.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
									caseWrite: { caseType: "client", property: "notes" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "client",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "notes", label: proseText("Notes") },
					],
				},
			],
		});
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "addField",
					parentUuid: formUuid(doc),
					field: {
						uuid: testUuid("case-ref-summary"),
						kind: "label",
						id: "client_summary",
						label: {
							parts: [
								{ kind: "text", text: "**Client:** " },
								{
									kind: "case-ref",
									caseType: "client",
									property: "case_name",
								},
							],
						},
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		const summary = verdict.nextDoc.fields[testUuid("case-ref-summary")];
		expect(summary?.kind).toBe("label");
		if (summary?.kind !== "label") return;
		expect(summary.label.parts[1]).toEqual({
			caseType: "client",
			kind: "case-ref",
			property: "case_name",
		});
	});

	it("rejects raw #case text parsed by the builder before it reaches storage", () => {
		const doc = minDoc();
		const target = Object.values(doc.fields).find(
			(field) => field.id === "village",
		);
		if (!target) throw new Error("fixture must have a village field");
		const parsed = parseXPathForField(doc, target.uuid, "#case/age > 0");
		expect(parsed.parts).toEqual([{ kind: "text", text: "#case/age > 0" }]);

		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: target.uuid,
					targetKind: "text",
					patch: { relevant: parsed },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.length).toBeGreaterThan(0);
			expect(describeCommitFindings(verdict.findings)).toMatch(
				/XPath|expression|reference/i,
			);
		}
		expect(doc.fields[target.uuid].relevant).toBeUndefined();
	});

	it("rejects removing the final Results field but allows empty Details", () => {
		const doc = minDoc();
		const moduleUuid = doc.moduleOrder[0];
		const column = doc.modules[moduleUuid].caseListConfig?.columns[0];
		if (!column) throw new Error("fixture must have a case-list column");

		const noResults = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateColumn",
					moduleUuid,
					uuid: column.uuid,
					visibilityPatch: { surface: "list", visible: false },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(noResults.ok).toBe(false);
		if (!noResults.ok) {
			expect(noResults.findings.map((finding) => finding.code)).toContain(
				"MISSING_CASE_LIST_COLUMNS",
			);
		}

		const noDetails = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateColumn",
					moduleUuid,
					uuid: column.uuid,
					visibilityPatch: { surface: "detail", visible: false },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(noDetails.ok).toBe(true);
	});

	it("rejects a soundness finding, with the finding attached", () => {
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
				// reducer's schema parse and the candidate would stay valid.)
				patch: { relevant: xp("if(") },
			} as Mutation,
		];

		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.length).toBeGreaterThan(0);
			expect(verdict.findings.every((e) => typeof e.message === "string")).toBe(
				true,
			);
		}
	});

	it("rejects a completeness finding — an entity lands with what makes it complete", () => {
		const doc = minDoc();
		const mutations: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: {
					uuid: testUuid("form-new"),
					id: "form_new",
					name: "Empty survey",
					type: "survey",
				} as never,
			},
		];

		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain("EMPTY_FORM");
		}
	});

	it("rejects a missing reducer target before candidate reduction", () => {
		const doc = minDoc();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: testUuid("missing-field"),
					targetKind: "text",
					patch: { label: proseText("Never applied") },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.nextDoc).toBe(doc);
			expect(verdict.findings.map((finding) => finding.code)).toEqual([
				"MUTATION_TARGET_INVALID",
			]);
		}
	});

	it("rejects a wrong-kind reducer target before candidate reduction", () => {
		const doc = minDoc();
		const target = Object.values(doc.fields).find(
			(field) => field.id === "village",
		);
		if (target === undefined) throw new Error("fixture must have village");
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: target.uuid,
					targetKind: "date",
					patch: { label: proseText("Never applied") },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.nextDoc).toBe(doc);
			expect(verdict.findings.map((finding) => finding.code)).toEqual([
				"MUTATION_TARGET_INVALID",
			]);
		}
	});

	it("rejects an already-invalid candidate even when the mutation is unrelated", () => {
		// The gate owns the complete resulting document. It has no prior-state
		// exception, so an unrelated edit cannot carry an invalid form forward.
		const broken = buildDoc({
			appName: "Test broken",
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
							],
						},
						// The starting document is invalid: this survey form is empty.
						{ name: "Old empty", type: "survey", fields: [] },
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});

		const verdict = mutationCommitVerdict(
			broken,
			[{ kind: "renameForm", uuid: formUuid(broken), newId: "form_two" }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((finding) => finding.code)).toContain(
				"EMPTY_FORM",
			);
		}
	});

	it("validates an empty batch and preserves a valid document by reference", () => {
		const doc = minDoc();
		const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(verdict).toMatchObject({ ok: true, nextDoc: doc, results: [] });
		if (!verdict.ok) throw new Error("empty batch rejected");
		expect(verdict.mutations).toEqual([]);
		expect(verdict.nextDoc).toBe(doc);
	});

	it("rejects an empty batch over an invalid document", () => {
		const broken = buildDoc({
			appName: "Invalid",
			modules: [],
			caseTypes: [],
		});
		const verdict = mutationCommitVerdict(
			broken,
			[],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((finding) => finding.code)).toContain(
				"NO_MODULES",
			);
		}
	});

	it("frames the findings person-to-person, one line each, nothing-was-changed", () => {
		const message = describeCommitFindings([
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
		const message = describeCommitFindings([
			validationError("EMPTY_FORM", "form", '"Visit" has no fields.', {}),
		]);
		expect(message).toContain("a problem");
		expect(message).toContain("this problem");
	});
});

// ── Stored-reference bounces — the repair the prose must name ────────

describe("stored-reference bounce prose", () => {
	/** minDoc plus a hidden total whose calculate references `village` by
	 * stable identity after the fixture's authoring boundary resolves it. */
	function docWithReference(): BlueprintDoc {
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "village",
									label: proseText("Village"),
									caseWrite: {
										caseType: "patient",
										property: "village",
									},
								}),
								f({
									kind: "hidden",
									id: "total",
									calculate: "#form/village",
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
					],
				},
			],
		});
	}

	it("delete bounce on an identity reference names the carrier, never the bare uuid", () => {
		const doc = docWithReference();
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		const verdict = mutationCommitVerdict(
			doc,
			[{ kind: "removeField", uuid: village?.uuid as never }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		const message = describeCommitFindings(verdict.findings);
		expect(message).toContain('Field "total"');
		expect(message).toContain("calculated value");
		expect(message).toContain("no longer exists");
		// The dangling leaf prints as the target's uuid — an internal id,
		// not a path anyone can find — so it must not reach the prose.
		expect(message).not.toContain(village?.uuid as string);
	});

	it("a same-batch field-ID update of a resolved reference still lands (identity needs no repair)", () => {
		const doc = docWithReference();
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: village?.uuid as never,
					targetKind: "text",
					patch: { id: "town" },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		// The identity leaf re-prints under the new name — nothing dangles.
		expect(verdict.ok).toBe(true);
	});
});
