import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { referenceContextChanged } from "../referenceContextChanged";

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ id: "name", kind: "text", label: proseText("Name") }],
					},
				],
			},
		],
	});
	const form = Object.values(doc.forms)[0];
	const field = Object.values(doc.fields)[0];
	if (!form || field?.kind !== "text")
		throw new Error("Missing typed text fixture");
	return { doc, form, field };
}

function lintDoc(doc: BlueprintDoc) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	return store.getState();
}

describe("Builder reference-context invalidation", () => {
	it("does not invalidate for a case-write-only edit that leaves the actual lint projection unchanged", () => {
		const { doc, field, form } = fixture();
		const next: BlueprintDoc = {
			...doc,
			fields: {
				...doc.fields,
				[field.uuid]: {
					...field,
					caseWrite: { caseType: "patient", property: "case_name" },
				},
			},
		};
		expect(buildLintContext(lintDoc(next), form.uuid)).toEqual(
			buildLintContext(lintDoc(doc), form.uuid),
		);
		expect(referenceContextChanged(next, doc)).toBe(false);
	});

	it("invalidates a field rename whose actual lint context changes", () => {
		const { doc, field, form } = fixture();
		const next: BlueprintDoc = {
			...doc,
			fields: { ...doc.fields, [field.uuid]: { ...field, id: "full_name" } },
		};
		expect(buildLintContext(lintDoc(next), form.uuid)).not.toEqual(
			buildLintContext(lintDoc(doc), form.uuid),
		);
		expect(referenceContextChanged(next, doc)).toBe(true);
	});

	it("observes field deletion even when another field identity takes its place", () => {
		const { doc, field } = fixture();
		const other = fixture().field;
		const next = {
			...doc,
			fields: { [other.uuid]: { ...field, uuid: other.uuid } },
		};
		expect(referenceContextChanged(next, doc)).toBe(true);
	});

	it.each(["fieldOrder", "formOrder", "caseTypes", "userProperties"] as const)(
		"observes the separately owned %s projection",
		(key) => {
			const { doc } = fixture();
			const current = doc[key];
			const next = {
				...doc,
				[key]:
					current === null || current === undefined
						? {}
						: structuredClone(current),
			};
			expect(referenceContextChanged(next, doc)).toBe(true);
			expect(referenceContextChanged(doc, doc)).toBe(false);
		},
	);
});
