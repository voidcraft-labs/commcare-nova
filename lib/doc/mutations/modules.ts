import type { Draft } from "immer";
import {
	spliceAfter,
	spliceEntryAfter,
	withoutEntry,
} from "@/lib/doc/mutations/sequence";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type CaseListConfig,
	caseSearchConfigHasAuthoredSettings,
	emptyCaseListConfig,
	isOwnerOnlyCaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
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
 * `moveModule` splices `moduleOrder`, because that array IS the sequence.
 *
 * The collection reducers key on the item uuid so two members editing different
 * columns / inputs merge. `add` is idempotent on uuid. A column `update` does
 * not have to protect the column's position: place lives in the config's two
 * ordering arrays, which a content edit never touches — so `preserve*` flags
 * are needed only for visibility, which does live on the column.
 *
 * Case-list columns are the one collection whose sequence is not its membership
 * array. Results and Details are two sequences over the same columns, so the
 * config carries `listColumnOrder` and `detailColumnOrder`, and a `moveColumn`
 * names which surface it reorders. The other is untouched, which is what lets
 * one author reorder Results while another reorders Details.
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
				| "addSearchInput"
				| "updateSearchInput"
				| "removeSearchInput"
				| "moveSearchInput"
				| "setCaseListMeta";
		}
	>,
): void {
	switch (mut.kind) {
		case "addModule": {
			const { uuid } = mut.module;
			const module = structuredClone(mut.module);
			draft.modules[uuid] = module;
			draft.formOrder[uuid] = [];
			// The membership array IS the sequence, so the add splices.
			draft.moduleOrder = spliceAfter(draft.moduleOrder, uuid, mut.after);
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
			// A move of a module a peer removed is a no-op — replay must not
			// resurrect it. `spliceAfter` inserts unconditionally, which is right
			// for an add and wrong for a move.
			if (draft.modules[mut.uuid] === undefined) return;
			// The membership array IS the sequence, so a move is a splice.
			draft.moduleOrder = spliceAfter(draft.moduleOrder, mut.uuid, mut.after);
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
			const entries: [string, unknown][] = Object.entries(mut.patch);
			if (
				mut.ensureCaseListConfig &&
				!Object.hasOwn(mut.patch, "caseListConfig")
			) {
				entries.push(["caseListConfig", undefined]);
			}
			if (
				(mut.caseSearchConfigPatch !== undefined ||
					mut.caseSearchConfigOperation !== undefined) &&
				!Object.hasOwn(mut.patch, "caseSearchConfig")
			) {
				entries.push(["caseSearchConfig", undefined]);
			}
			for (const [key, value] of entries) {
				if (key === "caseListConfig" && mut.ensureCaseListConfig) {
					ensureCaseListConfig(draft, mut.uuid);
					continue;
				}
				if (key === "caseListConfig" && value !== null && value !== undefined) {
					target[key] = structuredClone(value) as CaseListConfig;
					continue;
				}
				if (key === "caseSearchConfig" && mut.caseSearchConfigPatch) {
					const entries = Object.entries(mut.caseSearchConfigPatch);
					const clearOnly = entries.every(
						([, next]) => next === null || next === undefined,
					);
					if (mod.caseSearchConfig === undefined && clearOnly) continue;
					const fresh = mod.caseSearchConfig ?? {};
					const targetSearch = fresh as unknown as Record<string, unknown>;
					for (const [slot, next] of entries) {
						if (next === null || next === undefined) delete targetSearch[slot];
						else targetSearch[slot] = structuredClone(next);
					}
					if (
						fresh.searchActionEnabled === false &&
						!caseSearchConfigHasAuthoredSettings(fresh)
					) {
						delete mod.caseSearchConfig;
					} else {
						mod.caseSearchConfig = fresh;
					}
					continue;
				}
				if (key === "caseSearchConfig" && mut.caseSearchConfigOperation) {
					const operation = mut.caseSearchConfigOperation;
					if (operation === "set-owner-only") {
						const desiredOwnerIds = mut.caseSearchConfigValue?.excludedOwnerIds;
						if (desiredOwnerIds === undefined) continue;
						const freshRaw = mod.caseSearchConfig;
						const fresh =
							freshRaw === undefined
								? undefined
								: normalizeOwnerOnlyCaseSearchConfig(freshRaw);
						const searchIsFreshlyEnabled =
							(mod.caseListConfig?.searchInputs.length ?? 0) > 0 ||
							(fresh !== undefined && !isOwnerOnlyCaseSearchConfig(fresh));
						if (searchIsFreshlyEnabled) {
							// Same-slot owner edits are last-writer-wins, while every peer Search
							// setting and the peer's enabled action state survive this stale edit.
							const { searchActionEnabled: _intent, ...enabled } = fresh ?? {};
							mod.caseSearchConfig = {
								...enabled,
								excludedOwnerIds: desiredOwnerIds,
							};
						} else {
							mod.caseSearchConfig = {
								searchActionEnabled: false,
								excludedOwnerIds: desiredOwnerIds,
							};
						}
						continue;
					}
					if (operation === "enable") {
						// Enabling is an idempotent presence edit. Preserve authored peer
						// settings; clear only Nova's owner-only no-action provenance bit.
						if (mod.caseSearchConfig === undefined) {
							mod.caseSearchConfig = {};
						} else if (isOwnerOnlyCaseSearchConfig(mod.caseSearchConfig)) {
							const normalized = normalizeOwnerOnlyCaseSearchConfig(
								mod.caseSearchConfig,
							);
							const { searchActionEnabled: _disabled, ...enabled } = normalized;
							mod.caseSearchConfig = enabled;
						}
						continue;
					}
					if (operation === "disable-if-unused") {
						// A stale disable may arrive after a peer authored settings, added
						// another input, or added a Cases available condition. Only the
						// synthetic unused marker is safe to remove.
						if (
							mod.caseSearchConfig !== undefined &&
							mod.caseSearchConfig.searchActionEnabled !== false &&
							!caseSearchConfigHasAuthoredSettings(mod.caseSearchConfig) &&
							(mod.caseListConfig?.searchInputs.length ?? 0) === 0 &&
							effectiveFilterForEmission(mod.caseListConfig?.filter) ===
								undefined
						) {
							delete mod.caseSearchConfig;
						}
						continue;
					}
					if (operation === "remove-if-no-authored-settings") {
						// Intentional config-to-absent edit. Apply it against fresh state:
						// delete an empty marker even while inputs survive, but never erase a
						// title/action/owner setting authored by a peer while this was stale.
						if (
							mod.caseSearchConfig !== undefined &&
							!caseSearchConfigHasAuthoredSettings(mod.caseSearchConfig)
						) {
							delete mod.caseSearchConfig;
						}
						continue;
					}

					// Final-input cleanup is conditional on the fresh input set. Screen
					// copy disappears with the prompt screen; action and owner settings
					// are then canonicalized from fresh replay-time state.
					if ((mod.caseListConfig?.searchInputs.length ?? 0) > 0) continue;
					if (
						mod.caseSearchConfig !== undefined &&
						isOwnerOnlyCaseSearchConfig(mod.caseSearchConfig)
					) {
						mod.caseSearchConfig = normalizeOwnerOnlyCaseSearchConfig(
							mod.caseSearchConfig,
						);
					}
					const config = mod.caseSearchConfig;
					if (config === undefined) continue;
					delete config.searchScreenTitle;
					delete config.searchScreenSubtitle;
					const hasSearchActionSetting =
						config.searchButtonLabel !== undefined ||
						config.searchButtonDisplayCondition !== undefined;
					const hasCasesAvailableCondition =
						effectiveFilterForEmission(mod.caseListConfig?.filter) !==
						undefined;
					if (hasSearchActionSetting || hasCasesAvailableCondition) {
						delete config.searchActionEnabled;
						continue;
					}
					if (config.excludedOwnerIds !== undefined) {
						config.searchActionEnabled = false;
						continue;
					}
					delete mod.caseSearchConfig;
					continue;
				}
				if (value === null || value === undefined) delete target[key];
				else target[key] = value;
			}
			return;
		}
		case "setModuleMedia": {
			// Set or clear the module's menu media (home-screen tile `icon` +
			// `audioLabel`). The mutation carries explicit `MediaAssetId | null`
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
			// A DEEP copy, not a spread: the payload must not become part of a
			// produced (frozen) state that a later apply of the same batch edits in
			// place. A spread leaves `tile`, `sort`, and any expression aliased.
			const column = structuredClone(mut.column);
			config.columns.push(column);
			// The column joins BOTH sequences, at the placement each one named.
			config.listColumnOrder = spliceAfter(
				config.listColumnOrder,
				mut.column.uuid,
				mut.afterInList,
			);
			config.detailColumnOrder = spliceAfter(
				config.detailColumnOrder,
				mut.column.uuid,
				mut.afterInDetail,
			);
			return;
		}
		case "updateColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.columns.findIndex((c) => c.uuid === mut.uuid);
			if (idx === -1) return;
			const current = config.columns[idx];
			if (mut.visibilityPatch) {
				const key =
					mut.visibilityPatch.surface === "list"
						? "visibleInList"
						: "visibleInDetail";
				if (mut.visibilityPatch.visible) delete current[key];
				else current[key] = false;
				return;
			}
			if (mut.sortPatch !== undefined) {
				if (mut.sortPatch === null) delete current.sort;
				else current.sort = structuredClone(mut.sortPatch);
				return;
			}
			if (mut.tilePatch !== undefined) {
				if (mut.tilePatch === null) delete current.tile;
				else current.tile = structuredClone(mut.tilePatch);
				return;
			}
			if (mut.column === undefined) return;
			const replacement = {
				...structuredClone(mut.column),
				uuid: mut.uuid,
				...(current.sort === undefined ? {} : { sort: { ...current.sort } }),
				...(current.tile === undefined ? {} : { tile: { ...current.tile } }),
				...(current.visibleInList === undefined
					? {}
					: { visibleInList: current.visibleInList }),
				...(current.visibleInDetail === undefined
					? {}
					: { visibleInDetail: current.visibleInDetail }),
			};
			config.columns[idx] = replacement;
			return;
		}
		case "removeColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.columns.findIndex((c) => c.uuid === mut.uuid);
			if (idx !== -1) config.columns.splice(idx, 1);
			// The column leaves BOTH sequences with the set. A uuid left behind is
			// a member of neither screen and a member of both orders — `assemble`
			// refuses that document, and a later add naming the ghost as its anchor
			// would land somewhere nobody asked for.
			config.listColumnOrder = withoutEntry(config.listColumnOrder, mut.uuid);
			config.detailColumnOrder = withoutEntry(
				config.detailColumnOrder,
				mut.uuid,
			);
			return;
		}
		case "moveColumn": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			// A column a peer removed cannot be moved back into a sequence.
			if (!config.columns.some((column) => column.uuid === mut.uuid)) return;
			// Only the named surface moves. The other keeps its sequence, which is
			// what lets one author reorder Results while another reorders Details.
			if (mut.surface === "list") {
				config.listColumnOrder = spliceAfter(
					config.listColumnOrder,
					mut.uuid,
					mut.after,
				);
			} else {
				config.detailColumnOrder = spliceAfter(
					config.detailColumnOrder,
					mut.uuid,
					mut.after,
				);
			}
			return;
		}
		case "addSearchInput": {
			const config = ensureCaseListConfig(draft, mut.moduleUuid);
			if (!config) return;
			if (config.searchInputs.some((s) => s.uuid === mut.searchInput.uuid)) {
				return;
			}
			config.searchInputs = spliceEntryAfter(
				config.searchInputs,
				structuredClone(mut.searchInput),
				mut.after,
			);
			return;
		}
		case "updateSearchInput": {
			const config = draft.modules[mut.moduleUuid]?.caseListConfig;
			if (!config) return;
			const idx = config.searchInputs.findIndex((s) => s.uuid === mut.uuid);
			if (idx === -1) return;
			config.searchInputs[idx] = {
				...structuredClone(mut.searchInput),
				uuid: mut.uuid,
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
			if (!config) return;
			// `searchInputs` is the sequence, so the move reorders the array itself.
			// An input a peer removed cannot be moved back into it.
			const input = config.searchInputs.find((s) => s.uuid === mut.uuid);
			if (input === undefined) return;
			config.searchInputs = spliceEntryAfter(
				config.searchInputs,
				input,
				mut.after,
			);
			return;
		}
		case "setCaseListMeta": {
			// Edit the metadata of an EXISTING config — never births one. A
			// module whose config a peer concurrently cleared is a MISSING target
			// (the guarded commit's `batchTargetsMissing` turns this into a 409
			// reload), not a config to resurrect empty: reading the config directly
			// (not the semantic config ensure) leaves this a no-op if the guard is ever
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
 * `searchInputs: []`) when absent so the semantic `updateModule` ensure and
 * membership-adding reducers are total. An `addColumn` / `addSearchInput`
 * against a config-less module still births it (a module's first case-list
 * item is a legitimate config-birth). Returns `undefined` only when the module
 * itself is missing.
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
	mod.caseListConfig ??= emptyCaseListConfig();
	return mod.caseListConfig;
}
