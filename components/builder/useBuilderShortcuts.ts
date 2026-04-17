import { useMemo } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { notifyMoveRename } from "@/lib/doc/mutations/notify";
import {
	flattenFieldRefs,
	getCrossLevelFieldMoveTargets,
	getFieldMoveTargets,
} from "@/lib/doc/navigation";
import { asUuid, type Uuid } from "@/lib/doc/types";
import {
	useDeleteSelectedField,
	useUndoRedo,
} from "@/lib/routing/builderActions";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import type { Shortcut } from "@/lib/services/keyboardManager";
import { useBuilderIsReady, useCursorMode } from "@/lib/session/hooks";
import type { CursorMode } from "@/lib/session/types";

/**
 * Builds a memoized keyboard shortcuts array for the builder layout.
 *
 * Returns an empty array when the builder is not in Ready/Completed phase.
 * When active, includes: Escape (deselect/exit pointer), V/E (switch cursor
 * mode), Tab/Shift+Tab (navigate questions in edit mode), Delete/Backspace
 * (delete question), Cmd+D (duplicate), ArrowUp/ArrowDown (reorder),
 * Shift+ArrowUp/Shift+ArrowDown (cross-level indent/outdent),
 * Cmd+Z/Cmd+Shift+Z (undo/redo).
 *
 * All navigation and selection is URL-driven — the hook reads the current
 * location via `useLocation()`, dispatches selection via `useSelect()`, and
 * fires mutations via uuid-first `useBlueprintMutations()`. Handlers read
 * the doc imperatively at fire time via `useBlueprintDocApi()` — no need
 * to subscribe to entity-map slices; the handlers only run on keystrokes,
 * and always-fresh state beats any reactive re-render here.
 */
export function useBuilderShortcuts(
	handleCursorModeChange: (mode: CursorMode) => void,
): Shortcut[] {
	const isReady = useBuilderIsReady();
	const loc = useLocation();
	const select = useSelect();
	const { setPending } = useScrollIntoView();
	const deleteSelected = useDeleteSelectedField();
	const { undo, redo } = useUndoRedo();
	const { duplicateField, moveField } = useBlueprintMutations();
	const cursorMode = useCursorMode();
	/* Imperative store handle — handlers read the freshest doc snapshot at
	 * fire time. The hook never subscribes to a slice, so keystrokes never
	 * trigger a component re-render on unrelated mutations. */
	const docApi = useBlueprintDocApi();

	return useMemo(() => {
		if (!isReady) return [];

		/** Navigate to a field by uuid — update selection via URL and
		 *  request a scroll to bring the question into view. */
		const navigateToField = (uuid: Uuid): void => {
			setPending(uuid, "smooth", false);
			select(uuid);
		};

		return [
			// Escape — deselect / exit pointer mode
			{
				key: "Escape",
				handler: () => {
					if (cursorMode === "pointer") {
						handleCursorModeChange("edit");
						return;
					}
					if (loc.kind === "form" && loc.selectedUuid) {
						select(undefined);
						return;
					}
				},
			},
			// V/E — switch cursor mode (Figma-style single-key shortcuts,
			// suppressed when an input/editor is focused via keyboardManager)
			{ key: "v", handler: () => handleCursorModeChange("pointer") },
			{ key: "e", handler: () => handleCursorModeChange("edit") },
			// Tab / Shift+Tab — navigate fields in depth-first order, edit mode only
			{
				key: "Tab",
				handler: () => {
					if (cursorMode !== "edit") return;
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const refs = flattenFieldRefs(docApi.getState(), loc.formUuid);
					if (!refs.length) return;
					const curIdx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
					const next = refs[(curIdx + 1) % refs.length];
					navigateToField(next.uuid);
				},
			},
			{
				key: "Tab",
				shift: true,
				handler: () => {
					if (cursorMode !== "edit") return;
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const refs = flattenFieldRefs(docApi.getState(), loc.formUuid);
					if (!refs.length) return;
					const curIdx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
					const prev = refs[curIdx <= 0 ? refs.length - 1 : curIdx - 1];
					navigateToField(prev.uuid);
				},
			},
			// Delete / Backspace — delete selected field
			{
				key: "Delete",
				handler: () => {
					if (loc.kind === "form" && loc.selectedUuid) deleteSelected();
				},
			},
			{
				key: "Backspace",
				handler: () => {
					if (loc.kind === "form" && loc.selectedUuid) deleteSelected();
				},
			},
			// Cmd+D — duplicate field via doc mutation
			{
				key: "d",
				meta: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const result = duplicateField(asUuid(loc.selectedUuid));
					if (!result) return;
					navigateToField(asUuid(result.newUuid));
				},
			},
			// ArrowUp/ArrowDown — reorder within sibling level via doc mutation
			{
				key: "ArrowUp",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const { beforeUuid } = getFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!beforeUuid) return;
					moveField(asUuid(loc.selectedUuid), { beforeUuid });
				},
			},
			{
				key: "ArrowDown",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const { afterUuid } = getFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!afterUuid) return;
					moveField(asUuid(loc.selectedUuid), { afterUuid });
				},
			},
			// Shift+ArrowUp/Shift+ArrowDown — cross-level (indent/outdent) reorder.
			// `notifyMoveRename` pops the rename-dedup toast when a cross-parent
			// move collided with a sibling id and the reducer auto-renamed.
			{
				key: "ArrowUp",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const { up } = getCrossLevelFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!up) return;
					const result = moveField(asUuid(loc.selectedUuid), {
						toParentUuid: up.toParentUuid,
						...(up.beforeUuid ? { beforeUuid: up.beforeUuid } : {}),
						...(up.afterUuid ? { afterUuid: up.afterUuid } : {}),
					});
					notifyMoveRename(result);
				},
			},
			{
				key: "ArrowDown",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const { down } = getCrossLevelFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!down) return;
					const result = moveField(asUuid(loc.selectedUuid), {
						toParentUuid: down.toParentUuid,
						...(down.beforeUuid ? { beforeUuid: down.beforeUuid } : {}),
						...(down.afterUuid ? { afterUuid: down.afterUuid } : {}),
					});
					notifyMoveRename(result);
				},
			},
			// Cmd+Z / Cmd+Shift+Z — undo/redo (not global: TipTap and CodeMirror
			// have their own undo stacks that should handle Cmd+Z when focused)
			{
				key: "z",
				meta: true,
				handler: undo,
			},
			{
				key: "z",
				meta: true,
				shift: true,
				handler: redo,
			},
		];
	}, [
		isReady,
		loc,
		docApi,
		setPending,
		select,
		handleCursorModeChange,
		deleteSelected,
		undo,
		redo,
		duplicateField,
		moveField,
		cursorMode,
	]);
}
