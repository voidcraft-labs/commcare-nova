import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm } from "./helpers";

/**
 * Module mutations operate on the `modules`, `moduleOrder`, and `formOrder`
 * maps. Removal cascades: dropping a module drops its forms (which drop
 * their fields via `cascadeDeleteForm`).
 *
 * `renameModule` maps to the module's `name` field — modules have no
 * dedicated slug in the blueprint schema; `name` is the user-visible
 * identifier. The mutation's `newId` is the target display name.
 */
export function applyModuleMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addModule"
				| "removeModule"
				| "moveModule"
				| "renameModule"
				| "updateModule"
				| "setModuleMedia";
		}
	>,
): void {
	switch (mut.kind) {
		case "addModule": {
			const { uuid } = mut.module;
			draft.modules[uuid] = mut.module;
			draft.formOrder[uuid] = [];
			const index = mut.index ?? draft.moduleOrder.length;
			const clamped = Math.max(0, Math.min(index, draft.moduleOrder.length));
			draft.moduleOrder.splice(clamped, 0, uuid);
			return;
		}
		case "removeModule": {
			const { uuid } = mut;
			if (draft.modules[uuid] === undefined) return;
			// Cascade: delete each form and its field subtree before clearing the module.
			for (const formUuid of [...(draft.formOrder[uuid] ?? [])]) {
				cascadeDeleteForm(draft, formUuid);
			}
			delete draft.formOrder[uuid];
			delete draft.modules[uuid];
			const orderIndex = draft.moduleOrder.indexOf(uuid);
			if (orderIndex !== -1) draft.moduleOrder.splice(orderIndex, 1);
			return;
		}
		case "moveModule": {
			const { uuid, toIndex } = mut;
			const from = draft.moduleOrder.indexOf(uuid);
			if (from === -1) return;
			// Remove first, then clamp against the post-removal length.
			draft.moduleOrder.splice(from, 1);
			const clamped = Math.max(0, Math.min(toIndex, draft.moduleOrder.length));
			draft.moduleOrder.splice(clamped, 0, uuid);
			return;
		}
		case "renameModule": {
			// `name` is the sole user-visible identifier on a module entity.
			const mod = draft.modules[mut.uuid];
			if (mod) mod.name = mut.newId;
			return;
		}
		case "updateModule": {
			const mod = draft.modules[mut.uuid];
			if (!mod) return;
			// Apply the patch key-by-key: a `null` (the wire representation of a
			// clear — JSON drops `undefined`, so a cleared optional slot crosses
			// the persistence wire as `null`) or `undefined` (an in-memory clear)
			// DELETES the slot; any other value sets it. The patch schema admits
			// `null` only on the clearable (optional) slots, so a required slot
			// can never reach here as `null`.
			const target = mod as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null || value === undefined) delete target[key];
				else target[key] = value;
			}
			return;
		}
		case "setModuleMedia": {
			// Set or clear the module's menu media (home-screen tile `icon` +
			// `audioLabel`). The mutation carries explicit `AssetId | null`
			// slots so a clear survives JSON over the SSE wire — a generic
			// `updateModule` patch would encode the clear as `{ key: undefined }`,
			// which `JSON.stringify` drops, leaving the stale ref on the client.
			// Each `null` maps to `undefined` here so the cleared slot drops off
			// the module (both slots are `.optional()`, never a stored `null`).
			const mod = draft.modules[mut.uuid];
			if (!mod) return;
			mod.icon = mut.icon ?? undefined;
			mod.audioLabel = mut.audioLabel ?? undefined;
			return;
		}
	}
}
