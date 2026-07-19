import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type CaseListConfig,
	caseSearchConfigHasAuthoredSettings,
	isOwnerOnlyCaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	renameSearchInputInExpression,
	renameSearchInputInPredicate,
} from "@/lib/domain/predicate";
import { cascadeDeleteForm } from "./helpers";
import { rewriteModuleSearchInputRefs } from "./referenceRewrites";

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
 * Details order keys. New content emitters opt into preserving both visibility
 * slots too (so a stale edit cannot clobber a concurrent hide/show); legacy
 * events retain their historical full-body behavior. Each move or visibility
 * edit writes only its named surface slot and leaves membership untouched.
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
			// The nested module is the origin-compatible fallback snapshot. Rebuild
			// current-only nested state from optional top-level extensions without
			// mutating the payload object shared by the event log/caller.
			const module = structuredClone(mut.module);
			const columns = module.caseListConfig?.columns;
			if (columns !== undefined) {
				const columnByUuid = new Map(
					columns.map((column) => [column.uuid, column]),
				);
				for (const surfaceOrders of mut.columnSurfaceOrders ?? []) {
					const column = columnByUuid.get(surfaceOrders.uuid);
					if (column === undefined) continue;
					if (surfaceOrders.listOrder !== undefined) {
						column.listOrder = surfaceOrders.listOrder;
					}
					if (surfaceOrders.detailOrder !== undefined) {
						column.detailOrder = surfaceOrders.detailOrder;
					}
				}
			}
			if (mut.caseSearchConfigValue !== undefined) {
				module.caseSearchConfig = structuredClone(mut.caseSearchConfigValue);
			}
			draft.modules[uuid] = module;
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
				if (key === "caseListConfig" && mut.ensureCaseListConfig) {
					// New receivers interpret the optional semantic extension instead of
					// applying its empty old-client fallback snapshot. This makes a stale
					// absent -> present batch preserve a config a peer already populated.
					ensureCaseListConfig(draft, mut.uuid);
					continue;
				}
				if (key === "caseListConfig" && value !== null && value !== undefined) {
					const config = structuredClone(value) as CaseListConfig;
					const columnByUuid = new Map(
						config.columns.map((column) => [column.uuid, column]),
					);
					for (const surfaceOrders of mut.columnSurfaceOrders ?? []) {
						const column = columnByUuid.get(surfaceOrders.uuid);
						if (column === undefined) continue;
						if (surfaceOrders.listOrder !== undefined) {
							column.listOrder = surfaceOrders.listOrder;
						}
						if (surfaceOrders.detailOrder !== undefined) {
							column.detailOrder = surfaceOrders.detailOrder;
						}
					}
					target[key] = config;
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
			const column = { ...mut.column };
			if (mut.surfaceOrders?.listOrder !== undefined) {
				column.listOrder = mut.surfaceOrders.listOrder;
			}
			if (mut.surfaceOrders?.detailOrder !== undefined) {
				column.detailOrder = mut.surfaceOrders.detailOrder;
			}
			config.columns.push(column);
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
			// Always preserve CURRENT order keys. New emitters also mark content-only
			// replacements to preserve CURRENT visibility; an unmarked event retains
			// the pre-granular full-body behavior for persisted replay / old clients.
			// Delete absent current keys too: a stale payload may still carry one.
			const replacement = { ...mut.column, uuid: mut.uuid };
			for (const key of ["order", "listOrder", "detailOrder"] as const) {
				if (current[key] === undefined) delete replacement[key];
				else replacement[key] = current[key];
			}
			if (mut.preserveVisibility) {
				// Visibility true is canonicalized as absence by the dedicated mutation.
				for (const key of ["visibleInList", "visibleInDetail"] as const) {
					if (current[key] === undefined) delete replacement[key];
					else replacement[key] = current[key];
				}
			}
			if (mut.preserveSort) {
				if (current.sort === undefined) delete replacement.sort;
				// `current` is an Immer draft; structuredClone rejects its Proxy.
				// ColumnSort is a flat value, so a shallow copy safely detaches it.
				else replacement.sort = { ...current.sort };
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
			if (col) {
				const surfacePatch = mut.surfaceOrderPatch;
				if (surfacePatch === undefined) {
					// Persisted/pre-extension event: retain the historical generic move.
					col.order = mut.order;
					return;
				}
				const key =
					surfacePatch.surface === "list" ? "listOrder" : "detailOrder";
				if (surfacePatch.order === null) delete col[key];
				else col[key] = surfacePatch.order;
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
			const mod = draft.modules[mut.moduleUuid];
			const config = mod?.caseListConfig;
			if (!config) return;
			const idx = config.searchInputs.findIndex((s) => s.uuid === mut.uuid);
			if (idx === -1) return;
			const current = config.searchInputs[idx];
			const freshName = current.name;
			const fallbackName = mut.searchInput.name;
			const desiredName = mut.renamedTo ?? fallbackName;
			const order = current.order;
			const replacement = structuredClone(mut.searchInput);
			// A rename's origin-compatible row retains the old declaration name,
			// including any self-reference in its own default/predicate. Rewrite that
			// incoming row locally before installing it. Module-wide old-name rewrites
			// are conditional below because a peer may already have reused the freed
			// name for a different input identity.
			if (fallbackName !== desiredName) {
				if (replacement.default !== undefined) {
					renameSearchInputInExpression(
						replacement.default,
						fallbackName,
						desiredName,
					);
				}
				if (replacement.kind === "advanced") {
					renameSearchInputInPredicate(
						replacement.predicate,
						fallbackName,
						desiredName,
					);
				}
			}
			config.searchInputs[idx] = {
				...replacement,
				uuid: mut.uuid,
				name: desiredName,
				...(order !== undefined && { order }),
			};
			// References to the fresh target name are identity-safe: they were rewritten
			// when this same uuid was renamed by a peer, so always carry them forward.
			if (freshName !== desiredName) {
				rewriteModuleSearchInputRefs(mod, freshName, desiredName);
			}
			// The fallback name is safe module-wide only while no different fresh row
			// owns it. Otherwise those refs belong to that new uuid; rewriting them
			// would corrupt peer work merely because this stale payload remembers the
			// original declaration name.
			const fallbackOwnedByPeer = config.searchInputs.some(
				(input) => input.uuid !== mut.uuid && input.name === fallbackName,
			);
			if (
				fallbackName !== desiredName &&
				fallbackName !== freshName &&
				!fallbackOwnedByPeer
			) {
				rewriteModuleSearchInputRefs(mod, fallbackName, desiredName);
			}
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
	mod.caseListConfig ??= { columns: [], searchInputs: [] };
	return mod.caseListConfig;
}
