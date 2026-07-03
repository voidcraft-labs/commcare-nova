import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm } from "./helpers";

/**
 * Form mutations — fine-grained only.
 *
 * `renameForm` maps to the form's `name` field (the only user-editable
 * free-form identifier on a form). The `id`-style slug doesn't exist on
 * forms; CommCare derives the form's XForm id from its position.
 *
 * Wholesale-swap semantics (e.g. replacing a form's entire field subtree)
 * are expressed by composing `updateForm + removeField × N + addField × M`
 * at the agent-stream mutation mapper — this reducer has no dedicated
 * wholesale kind and stays focused on a single fine-grained operation
 * per case.
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
				| "setFormMedia";
		}
	>,
): void {
	switch (mut.kind) {
		case "addForm": {
			if (draft.modules[mut.moduleUuid] === undefined) return;
			const { uuid } = mut.form;
			draft.forms[uuid] = mut.form;
			draft.fieldOrder[uuid] = [];
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
			cascadeDeleteForm(draft as unknown as BlueprintDoc, mut.uuid);
			return;
		}
		case "moveForm": {
			const form = draft.forms[mut.uuid];
			if (form === undefined) return;
			if (draft.modules[mut.toModuleUuid] === undefined) return;
			// New emission: write the fractional `order` verbatim. A same-module
			// reorder leaves every membership array untouched; a cross-module move
			// also relocates the form's membership (position arbitrary — the
			// `order` key, not array position, decides display sequence).
			if (mut.order !== undefined) {
				form.order = mut.order;
				let currentModule: string | undefined;
				for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
					if (formList.includes(mut.uuid)) {
						currentModule = modUuid;
						break;
					}
				}
				if (currentModule !== mut.toModuleUuid) {
					if (currentModule !== undefined) {
						const src = draft.formOrder[currentModule];
						const idx = src.indexOf(mut.uuid);
						if (idx !== -1) src.splice(idx, 1);
					}
					const dest = draft.formOrder[mut.toModuleUuid] ?? [];
					if (!dest.includes(mut.uuid)) dest.push(mut.uuid);
					draft.formOrder[mut.toModuleUuid] = dest;
				}
				return;
			}
			// Legacy replay: an array-position move (pre-`order` events).
			if (mut.toIndex === undefined) return;
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
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
			// Apply the patch key-by-key: a `null` (the wire representation of a
			// clear — JSON drops `undefined`, so a cleared optional slot crosses
			// the persistence wire as `null`) or `undefined` (an in-memory clear)
			// DELETES the slot; any other value sets it. The patch schema admits
			// `null` only on the clearable (optional) slots, so a required slot
			// can never reach here as `null`.
			const target = form as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null || value === undefined) delete target[key];
				else target[key] = value;
			}
			return;
		}
		case "setFormMedia": {
			// Set or clear the form's menu media (tile `icon` + `audioLabel`).
			// Mirrors `setModuleMedia` one level down: explicit `AssetId | null`
			// slots so a clear survives JSON over the SSE wire (a generic
			// `updateForm` patch would encode it as `{ key: undefined }`, which
			// `JSON.stringify` drops). Each `null` maps to `undefined` so the
			// cleared slot drops off the form.
			const form = draft.forms[mut.uuid];
			if (!form) return;
			form.icon = mut.icon ?? undefined;
			form.audioLabel = mut.audioLabel ?? undefined;
			return;
		}
	}
}
