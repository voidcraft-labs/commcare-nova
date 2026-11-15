/**
 * Where two documents differ.
 *
 * Contract: `documentDifferences` reports a value both documents hold and
 * differ in as `value`, a path only the first document holds as `missing`,
 * and one only the second holds as `added`, each as the keys from the
 * document's root, in a depth-first walk with object keys sorted; two equal
 * documents give none, whatever order their keys were written in.
 *
 * Plausible failures: a difference the walk does not report, which the
 * fixed point of a reading, a read back and a review of changes made in
 * CommCare HQ would each miss; a key absent on one side reported as a changed
 * value, or the two kinds swapped; a derived slot or a key's order reported as
 * a difference of two equal documents.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { documentDifferences } from "../documentDifferences";

function app(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Clients",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "first", label: "First" }),
							f({ kind: "text", id: "second", label: "Second" }),
						],
					},
				],
			},
		],
	});
}

function fieldUuid(doc: BlueprintDoc, id: string): Uuid {
	const found = Object.values(doc.fields).find((one) => one.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found.uuid;
}

describe("documentDifferences", () => {
	it("gives none for two equal documents, whatever order their keys were written in", () => {
		const doc = app();
		const reordered = JSON.parse(
			JSON.stringify(doc, (_key, value) =>
				value !== null && typeof value === "object" && !Array.isArray(value)
					? Object.fromEntries(Object.entries(value).reverse())
					: value,
			),
		) as BlueprintDoc;
		expect(documentDifferences(doc, reordered)).toEqual([]);
		// A derived slot is no part of the document.
		expect(
			documentDifferences(doc, { ...doc, fieldParent: {} } as BlueprintDoc),
		).toEqual([]);
	});

	it("reports a changed value, a path the first document alone holds and one the second alone holds", () => {
		const doc = app();
		const first = fieldUuid(doc, "first");
		const second = fieldUuid(doc, "second");
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		// The expected document holds a purpose note; the other renames one
		// question and gives the other a hint.
		const expected = produce(doc, (draft) => {
			const form = draft.forms[formUuid];
			if (form !== undefined) form.purpose = "Why";
		});
		const actual = produce(doc, (draft) => {
			(draft.fields[first] as unknown as Record<string, unknown>).id =
				"renamed";
			(draft.fields[second] as unknown as Record<string, unknown>).hint = {
				parts: [{ kind: "text", text: "Added" }],
			};
		});
		// Object keys in code-unit order: `fields` before `forms`, and the two
		// questions by their uuids.
		const byField = [first, second]
			.sort()
			.map((uuid) =>
				uuid === first
					? { path: ["fields", first, "id"], kind: "value" }
					: { path: ["fields", second, "hint"], kind: "added" },
			);
		expect(documentDifferences(expected, actual)).toEqual([
			...byField,
			{ path: ["forms", formUuid, "purpose"], kind: "missing" },
		]);
	});

	it("walks an array by position, reporting the positions one side alone holds", () => {
		const doc = app();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const [first, second] = doc.fieldOrder[formUuid] ?? [];
		const one = produce(doc, (draft) => {
			draft.fieldOrder[formUuid] = [first as Uuid];
		});
		expect(documentDifferences(doc, one)).toEqual([
			{ path: ["fieldOrder", formUuid, "1"], kind: "missing" },
		]);
		expect(documentDifferences(one, doc)).toEqual([
			{ path: ["fieldOrder", formUuid, "1"], kind: "added" },
		]);
		const swapped = produce(doc, (draft) => {
			draft.fieldOrder[formUuid] = [second as Uuid, first as Uuid];
		});
		expect(documentDifferences(doc, swapped)).toEqual([
			{ path: ["fieldOrder", formUuid, "0"], kind: "value" },
			{ path: ["fieldOrder", formUuid, "1"], kind: "value" },
		]);
	});

	it("reports a value replaced by an object, or a key holding undefined against one holding a value, once at its path", () => {
		const doc = app();
		const first = fieldUuid(doc, "first");
		const objectName = produce(doc, (draft) => {
			(draft as unknown as Record<string, unknown>).appName = {
				text: "Clients",
			};
		});
		expect(documentDifferences(doc, objectName)).toEqual([
			{ path: ["appName"], kind: "value" },
		]);
		const undefinedHint = produce(doc, (draft) => {
			(draft.fields[first] as unknown as Record<string, unknown>).hint =
				undefined;
		});
		expect(documentDifferences(doc, undefinedHint)).toEqual([]);
	});
});
