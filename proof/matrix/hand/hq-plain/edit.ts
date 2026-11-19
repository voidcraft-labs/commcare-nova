/**
 * The edit the base `hq-plain` states, D to D′: the follow-up form gains a
 * text question `follow_up_note` after `remark`, and the registration form's
 * `remark` (in the group `notes`) is labelled anew. Proof 5's footprint is
 * both forms.
 *
 * It finds its targets by what CommCare HQ's app keys them by, a form by its
 * place in the app and a question by its path in its form, never by a Nova
 * UUID, so the same edit applies to the hand-written document and to any
 * reading of the base at any pin. The UUID of the question it adds is
 * written out.
 */

import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, proseText, type Uuid } from "@/lib/domain";

/** The question the edit adds. */
export const FOLLOW_UP_NOTE = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a41" as Uuid;

/** The form at `place` of the app's first menu. */
function formAt(doc: BlueprintDoc, place: number): Uuid {
	const [menu] = doc.moduleOrder;
	const form = menu === undefined ? undefined : doc.formOrder[menu]?.[place];
	if (form === undefined)
		throw new Error(
			`The edit of hq-plain changes form ${place} of the app's first menu, and the document holds none there. proof/matrix/bases/plain.py authors a menu with a registration form and a follow-up form.`,
		);
	return form;
}

/** The question at `path` (question ids from the form down) of `form`. */
function fieldAt(doc: BlueprintDoc, form: Uuid, path: readonly string[]): Uuid {
	let parent: Uuid = form;
	for (const id of path) {
		const found = (doc.fieldOrder[parent] ?? []).find(
			(uuid) => doc.fields[uuid]?.id === id,
		);
		if (found === undefined)
			throw new Error(
				`The edit of hq-plain changes the question ${path.join("/")}, and the form holds none there.`,
			);
		parent = found;
	}
	return parent;
}

export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const registration = formAt(doc, 0);
	const followUp = formAt(doc, 1);
	const remark = fieldAt(doc, registration, ["notes", "remark"]);
	const followUpRemark = fieldAt(doc, followUp, ["remark"]);
	return [
		{
			kind: "addField",
			parentUuid: followUp,
			after: followUpRemark,
			field: {
				uuid: FOLLOW_UP_NOTE,
				kind: "text",
				id: "follow_up_note",
				label: proseText("Follow-up note"),
				plainLabel: true,
			},
		} as Mutation,
		{
			kind: "updateField",
			uuid: remark,
			targetKind: "text",
			patch: { label: proseText("Anything else about the household") },
		} as Mutation,
	];
}
