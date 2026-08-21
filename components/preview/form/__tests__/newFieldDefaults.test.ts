import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Field, fieldKinds, fieldSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { NEW_FIELD_BUILDERS } from "../newFieldDefaults";

const UUID = testUuid("00000000-0000-4000-8000-000000000000");

describe("NEW_FIELD_BUILDERS — every kind's starter field is schema-valid", () => {
	// The mapped type guarantees each builder's STRUCTURE matches its kind, but
	// the Zod schema carries runtime constraints the type can't express
	// (`options.min(2)`, non-empty visible label). This is the guard that a
	// freshly-inserted field of ANY kind round-trips through `fieldSchema`, the
	// exact thing the auto-save validates, so the insertion can never mint an
	// unsaveable field again (the `hidden` + `label` regression).
	it.each(fieldKinds)("%s builds a valid field", (kind) => {
		const built = NEW_FIELD_BUILDERS[kind](`new_${kind}`, "New Field");
		const result = fieldSchema.safeParse({ ...built, uuid: UUID });
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues),
		).toBe(true);
	});

	it("never gives a hidden field a label (it has no label slot)", () => {
		const built = NEW_FIELD_BUILDERS.hidden("new_hidden", "ignored");
		expect("label" in built).toBe(false);
	});
});

describe("NEW_FIELD_BUILDERS — every starter passes the commit gate", () => {
	// Schema-valid is necessary but not sufficient: the insert dispatches
	// through `useBlueprintMutations`' gate, which also runs the validator
	// rules, and a starter that any rule flags as soundness is a DEAD menu
	// item (the insert is rejected on every attempt, in both phases). The
	// `hidden` starter shipped exactly that way once (no value source →
	// HIDDEN_NO_VALUE), which is why it now seeds `default_value: "''"`.
	// This sweep is the dissolution-style proof for the whole picker: a
	// starter the gate would refuse fails the suite the day it's authored.
	function pickerDoc() {
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
									caseWrite: { caseType: "patient", property: "case_name" },
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

	it.each(fieldKinds.filter((kind) => kind !== "section"))(
		"%s starter commits through the gate",
		(kind) => {
			const doc = pickerDoc();
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const built = NEW_FIELD_BUILDERS[kind](`new_${kind}`, "New Field");
			const field = { ...built, uuid: UUID } as Field;
			const verdict = mutationCommitVerdict(
				doc,
				[{ kind: "addField", parentUuid: formUuid, field }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(
				verdict.ok,
				verdict.ok
					? ""
					: `${kind}: ${verdict.findings.map((e) => e.code).join(", ")}`,
			).toBe(true);
		},
	);

	it("section starter commits through the gate as a page that carries the root's questions", () => {
		// A page is never a bare insert: once a form has one, every root
		// field must sit on a page (`FORM_SECTIONS_INCOMPLETE`), so the
		// picker plans the starter together with the moves
		// (`sectionGestureItems` → `splitIntoSections`). The starter itself
		// is what that plan adds, so it is proved the way it is used.
		const doc = pickerDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const root = doc.fieldOrder[formUuid] ?? [];
		const built = NEW_FIELD_BUILDERS.section("new_section", "New Field");
		const field = { ...built, uuid: UUID } as Field;
		const verdict = mutationCommitVerdict(
			doc,
			[
				{ kind: "addField", parentUuid: formUuid, field },
				...root.map((uuid, index) => ({
					kind: "moveField" as const,
					uuid,
					toParentUuid: UUID,
					after: index === 0 ? null : (root[index - 1] ?? null),
				})),
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			verdict.ok,
			verdict.ok
				? ""
				: `section: ${verdict.findings.map((e) => e.code).join(", ")}`,
		).toBe(true);
	});
});
