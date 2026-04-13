import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm, cascadeDeleteQuestion } from "./helpers";

/**
 * Form mutations. `replaceForm` is handled in a dedicated branch because it
 * has to atomically swap a form's entire subtree — questions and all nested
 * ordering — without disturbing siblings.
 *
 * `renameForm` maps to the form's `name` field (the only user-editable
 * free-form identifier on a form). The `id`-style slug doesn't exist on
 * forms; CommCare derives the form's XForm id from its position.
 */
export function applyFormMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addForm"
				| "removeForm"
				| "moveForm"
				| "renameForm"
				| "updateForm"
				| "replaceForm";
		}
	>,
): void {
	switch (mut.kind) {
		case "addForm": {
			if (draft.modules[mut.moduleUuid] === undefined) return;
			const { uuid } = mut.form;
			draft.forms[uuid] = mut.form;
			draft.questionOrder[uuid] = [];
			const order = draft.formOrder[mut.moduleUuid] ?? [];
			const index = mut.index ?? order.length;
			const clamped = Math.max(0, Math.min(index, order.length));
			order.splice(clamped, 0, uuid);
			draft.formOrder[mut.moduleUuid] = order;
			return;
		}
		case "removeForm": {
			if (draft.forms[mut.uuid] === undefined) return;
			// Find which module owns this form, remove from its order.
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
			cascadeDeleteForm(draft, mut.uuid);
			return;
		}
		case "moveForm": {
			if (draft.forms[mut.uuid] === undefined) return;
			if (draft.modules[mut.toModuleUuid] === undefined) return;
			// Remove from source module.
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
			// Insert into destination.
			const destOrder = draft.formOrder[mut.toModuleUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.formOrder[mut.toModuleUuid] = destOrder;
			return;
		}
		case "renameForm": {
			const form = draft.forms[mut.uuid];
			if (form) form.name = mut.newId;
			return;
		}
		case "updateForm": {
			const form = draft.forms[mut.uuid];
			if (!form) return;
			Object.assign(form, mut.patch);
			return;
		}
		case "replaceForm": {
			const existing = draft.forms[mut.uuid];
			if (!existing) return;
			// Drop the old question subtree (but don't touch formOrder — the
			// form stays in its module at the same position).
			const oldTop = draft.questionOrder[mut.uuid] ?? [];
			for (const qUuid of [...oldTop]) {
				cascadeDeleteQuestion(draft, qUuid);
			}
			// Swap the entity.
			draft.forms[mut.uuid] = mut.form;
			// Install the new questions.
			for (const q of mut.questions) {
				draft.questions[q.uuid] = q;
			}
			// Install the new ordering maps. Each entry replaces whatever
			// was there before (covers the top-level form slot and any nested
			// group/repeat containers).
			for (const [parent, order] of Object.entries(mut.questionOrder)) {
				draft.questionOrder[parent as keyof typeof draft.questionOrder] = order;
			}
			return;
		}
	}
}
