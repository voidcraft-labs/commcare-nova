import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type CaseListConfig,
	caseSearchConfigHasAuthoredSettings,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import { cascadeDeleteForm } from "./helpers";

/**
 * Module mutations operate on the `modules`, `moduleOrder`, and `formOrder`
 * maps, plus the per-module `caseListConfig` collections (`columns`,
 * `searchInputs`) and its non-array metadata (`filter` / case-list-link
 * `icon` / `audioLabel`). Removal cascades: dropping a module drops its forms
 * (which drop their fields via `cascadeDeleteForm`).
 *
 * `renameModule` maps to the module's `name` field — modules have no
 * dedicated slug in the blueprint schema; `name` is the user-visible
 * identifier. The mutation's `newId` is the target display name.
 *
 * `moveModule` is order-key-aware: a new emission carries the gesture-computed
 * fractional `order` and the reducer writes it verbatim (sequence is
 * `sort-by-(order, uuid)`, so the `moduleOrder` membership array is left
 * untouched); a legacy event carrying only `toIndex` still replays as an
 * array-position move.
 *
 * The collection reducers key on the item uuid so two members editing
 * different columns / inputs merge. `add` is idempotent on uuid; a column
 * `update` replaces content but PRESERVES its current generic, Results, and
 * Details order keys (so a content edit never clobbers a concurrent reorder);
 * each move writes only its named order key and leaves membership untouched.
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
				| "setModuleMedia"
				| "addColumn"
				| "updateColumn"
				| "removeColumn"
				| "moveColumn"
				| "moveColumnInList"
				| "moveColumnInDetail"
				| "addSearchInput"
				| "updateSearchInput"
				| "removeSearchInput"
				| "moveSearchInput"
				| "setCaseSearchMarker"
				| "setCaseListMeta";
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
			const { uuid } = mut;
			// New emission: write the fractional `order` verbatim; the
			// `moduleOrder` membership array is not the authoritative sequence,
			// so it is left untouched.
			if (mut.order !== undefined) {
				const mod = draft.modules[uuid];
				if (mod) mod.order = mut.order;
				return;
			}
			// Legacy replay: an array-position move (pre-`order` events).
			if (mut.toIndex === undefined) return;
			const from = draft.moduleOrder.indexOf(uuid);
			if (from === -1) return;
			draft.moduleOrder.splice(from, 1);
			const clamped = Math.max(
				0,
				Math.min(mut.toIndex, draft.moduleOrder.length),
			);
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
		case "addColumn": {
			const config = ensureCaseListConfig(draft, mut.moduleUuid);
			if (!config) return;
			// Idempotent on uuid (a re-applied add is a no-op).
			if (config.columns.some((c) => c.uuid === mut.column.uuid)) return;
			config.columns.push(mut.column);
			return;
		}
		case "updateColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.columns.findIndex((c) => c.uuid === mut.uuid);
			if (idx === -1) return;
			// Preserve all CURRENT order keys so a content edit never clobbers a
			// concurrent generic, Results, or Details reorder on the same item.
			// Delete absent current keys too: the mutation payload may have been
			// produced from a stale snapshot that still carried one.
			const current = config.columns[idx];
			const replacement = { ...mut.column, uuid: mut.uuid };
			for (const key of ["order", "listOrder", "detailOrder"] as const) {
				if (current[key] === undefined) delete replacement[key];
				else replacement[key] = current[key];
			}
			config.columns[idx] = replacement;
			return;
		}
		case "removeColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.columns.findIndex((c) => c.uuid === mut.uuid);
			if (idx !== -1) config.columns.splice(idx, 1);
			return;
		}
		case "moveColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			const col = config?.columns.find((c) => c.uuid === mut.uuid);
			if (col) col.order = mut.order;
			return;
		}
		case "moveColumnInList": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			const col = config?.columns.find((c) => c.uuid === mut.uuid);
			if (col) {
				if (mut.order === null) delete col.listOrder;
				else col.listOrder = mut.order;
			}
			return;
		}
		case "moveColumnInDetail": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			const col = config?.columns.find((c) => c.uuid === mut.uuid);
			if (col) {
				if (mut.order === null) delete col.detailOrder;
				else col.detailOrder = mut.order;
			}
			return;
		}
		case "addSearchInput": {
			const config = ensureCaseListConfig(draft, mut.moduleUuid);
			if (!config) return;
			if (config.searchInputs.some((s) => s.uuid === mut.searchInput.uuid)) {
				return;
			}
			config.searchInputs.push(mut.searchInput);
			return;
		}
		case "updateSearchInput": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.searchInputs.findIndex((s) => s.uuid === mut.uuid);
			if (idx === -1) return;
			const order = config.searchInputs[idx].order;
			config.searchInputs[idx] = {
				...mut.searchInput,
				uuid: mut.uuid,
				...(order !== undefined && { order }),
			};
			return;
		}
		case "removeSearchInput": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.searchInputs.findIndex((s) => s.uuid === mut.uuid);
			if (idx !== -1) config.searchInputs.splice(idx, 1);
			return;
		}
		case "moveSearchInput": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			const input = config?.searchInputs.find((s) => s.uuid === mut.uuid);
			if (input) input.order = mut.order;
			return;
		}
		case "setCaseSearchMarker": {
			const mod = draft.modules[mut.uuid];
			if (!mod) return;
			if (mut.enabled) {
				// Idempotent ensure: a peer's authored settings are stronger than
				// this presence-only marker and must survive a stale enable.
				if (mod.caseSearchConfig === undefined) mod.caseSearchConfig = {};
				return;
			}
			// Conditional cleanup: only the synthetic empty marker may disappear,
			// and only after the batch has removed the last thing that makes the
			// marker meaningful. A fresh peer input/filter/settings edit turns this
			// stale disable into a no-op rather than silently changing behavior.
			if (
				mod.caseSearchConfig !== undefined &&
				!caseSearchConfigHasAuthoredSettings(mod.caseSearchConfig) &&
				(mod.caseListConfig?.searchInputs.length ?? 0) === 0 &&
				effectiveFilterForEmission(mod.caseListConfig?.filter) === undefined
			) {
				delete mod.caseSearchConfig;
			}
			return;
		}
		case "setCaseListMeta": {
			// Edit the metadata of an EXISTING config — never births one. A
			// module whose config a peer concurrently cleared is a MISSING target
			// (the guarded commit's `batchTargetsMissing` turns this into a 409
			// reload), not a config to resurrect empty: reading the config directly
			// (not `ensureCaseListConfig`) leaves this a no-op if the guard is ever
			// bypassed, so a removed case list can't reappear as `{columns:[],
			// searchInputs:[]}` with a peer's filter stranded on it.
			const config = draft.modules[mut.uuid]?.caseListConfig;
			if (!config) return;
			// Apply the patch key-by-key: a `null` (wire spelling of a clear —
			// JSON drops `undefined`) DELETES the slot, any other value sets it.
			const target = config as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(mut.patch)) {
				if (value === null || value === undefined) delete target[key];
				else target[key] = value;
			}
			return;
		}
	}
}

/**
 * Resolve a module's `caseListConfig`, seeding an empty one (`columns: []`,
 * `searchInputs: []`) when absent so the membership-adding reducers are total —
 * an `addColumn` / `addSearchInput` against a config-less module births it (a
 * module's first case-list item is a legitimate config-birth). Returns
 * `undefined` only when the module itself is missing.
 *
 * `setCaseListMeta` deliberately does NOT route through here: patching an
 * always-on config's metadata (`filter` / `icon` / `audioLabel`) is an EDIT of
 * an existing config, and birthing one to hold a peer's filter would resurrect
 * a case list another member concurrently removed. It reads the config directly
 * and no-ops when absent; the guarded commit rejects that case as a conflict.
 */
function ensureCaseListConfig(
	draft: Draft<BlueprintDoc>,
	moduleUuid: string,
): Draft<CaseListConfig> | undefined {
	const mod = draft.modules[moduleUuid];
	if (!mod) return undefined;
	mod.caseListConfig ??= { columns: [], searchInputs: [] };
	return mod.caseListConfig;
}
