import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Uuid } from "@/lib/doc/types";
import { selectionAfterFieldDeletion } from "../deletionSelection";

function fixture() {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ kind: "text", id: "first" }),
								f({
									kind: "group",
									id: "details",
									children: [f({ kind: "text", id: "child" })],
								}),
								f({ kind: "hidden", id: "calculation" }),
								f({ kind: "text", id: "last" }),
							],
						},
					],
				},
			],
		}),
	);
	const doc = store.getState();
	const form = doc.formOrder[doc.moduleOrder[0]][0];
	const [first, group, hidden, last] = doc.fieldOrder[form];
	const child = doc.fieldOrder[group][0];
	return { store, form, first, group, hidden, last, child };
}

function remove(h: ReturnType<typeof fixture>, uuid: Uuid) {
	const before = h.store.getState();
	h.store.getState().applyMany([{ kind: "removeField", uuid }]);
	return selectionAfterFieldDeletion(before, h.store.getState(), h.form, uuid);
}

it("uses visible depth-first order, crossing container boundaries and skipping hidden fields", () => {
	const h = fixture();
	expect(remove(h, h.first)).toBe(h.group);
	expect(remove(h, h.last)).toBe(h.child);
	expect(remove(h, h.child)).toBe(h.group);
	expect(remove(h, h.group)).toBeUndefined();
});

it("skips every descendant removed with its selected container", () => {
	const h = fixture();
	expect(remove(h, h.group)).toBe(h.last);
	expect(h.store.getState().fields[h.child]).toBeUndefined();
	expect(remove(h, h.last)).toBe(h.first);
});

it("clears a hidden selection without jumping to the first visible field", () => {
	const h = fixture();
	expect(remove(h, h.hidden)).toBeUndefined();
	expect(h.store.getState().fields[h.first]).toBeDefined();
});
