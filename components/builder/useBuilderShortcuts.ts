import { useMemo } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { usePreviewModeTransition } from "@/components/builder/usePreviewModeTransition";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
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
import { useBuilderIsReady, usePreviewing } from "@/lib/session/hooks";
import type { Shortcut } from "@/lib/ui/keyboardManager";

/**
 * Builds a memoized keyboard shortcuts array for the builder layout.
 *
 * Returns an empty array when the builder is not in Ready/Completed phase.
 * When active, includes: Escape (deselect/exit preview), P (toggle
 * preview), Tab/Shift+Tab (navigate fields while editing), Delete/Backspace
 * (delete field), Cmd+D (duplicate), ArrowUp/ArrowDown (reorder),
 * Shift+ArrowUp/Shift+ArrowDown (cross-level indent/outdent),
 * Cmd+Z/Cmd+Shift+Z (undo/redo).
 *
 * All navigation and selection is URL-driven — the hook reads the current
 * location via `useLocation()`, dispatches selection via `useSelect()`, and
 * fires mutations via uuid-first `useBlueprintMutations()`. Mutation handlers
 * read the doc imperatively at fire time via `useBlueprintDocApi()` — no need
 * to subscribe to entity-map slices; the handlers only run on keystrokes, and
 * always-fresh state beats a reactive entity-map subscription here. The only
 * reactive doc values are the two undo/redo availability booleans, which let
 * those shortcuts decline when their history action cannot run.
 */
export function useBuilderShortcuts(
	setPreviewing: (on: boolean) => void,
): Shortcut[] {
	const isReady = useBuilderIsReady();
	const loc = useLocation();
	const select = useSelect();
	const { setPending } = useScrollIntoView();
	const deleteSelected = useDeleteSelectedField();
	const { undo, redo } = useUndoRedo();
	const canUndo = useCanUndo();
	const canRedo = useCanRedo();
	const { duplicateField, moveField } = useBlueprintMutations();
	const previewing = usePreviewing();
	const transitionPreview = usePreviewModeTransition(setPreviewing);
	/* Imperative store handle — field handlers read the freshest doc snapshot
	 * at fire time instead of subscribing to entity-map slices. */
	const docApi = useBlueprintDocApi();

	return useMemo(() => {
		if (!isReady) return [];

		/** Navigate to a field by uuid — update selection via URL and
		 *  request a scroll to bring the field into view. */
		const navigateToField = (uuid: Uuid): void => {
			setPending(uuid, "smooth", false);
			select(uuid);
		};

		return [
			// Escape — deselect / exit preview. Declines (returns
			// false) when neither applies so the key falls through to a
			// more specific registration (e.g. the case-list workspace's
			// inspector-closing Escape) instead of being eaten — this
			// registration re-registers on every doc mutation (the memo
			// depends on `loc`), so it routinely sits LAST in the manager's
			// recency order without being the most specific handler.
			{
				key: "Escape",
				handler: () => {
					if (previewing) {
						transitionPreview(false);
						return true;
					}
					if (loc.kind === "form" && loc.selectedUuid) {
						select(undefined);
						return true;
					}
					return false;
				},
			},
			// P — toggle preview (Figma-style single-key shortcut, suppressed
			// when an input/editor is focused via keyboardManager)
			{
				key: "p",
				handler: () => {
					transitionPreview(!previewing);
					return true;
				},
			},
			// Tab / Shift+Tab — navigate fields in depth-first order, editing only
			{
				key: "Tab",
				handler: () => {
					if (previewing) return false;
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const refs = flattenFieldRefs(docApi.getState(), loc.formUuid);
					if (!refs.length) return false;
					const curIdx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
					if (curIdx < 0) return false;
					const next = refs[(curIdx + 1) % refs.length];
					navigateToField(next.uuid);
					return true;
				},
			},
			{
				key: "Tab",
				shift: true,
				handler: () => {
					if (previewing) return false;
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const refs = flattenFieldRefs(docApi.getState(), loc.formUuid);
					if (!refs.length) return false;
					const curIdx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
					if (curIdx < 0) return false;
					const prev = refs[curIdx <= 0 ? refs.length - 1 : curIdx - 1];
					navigateToField(prev.uuid);
					return true;
				},
			},
			// Delete / Backspace — delete selected field
			{
				key: "Delete",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					deleteSelected();
					return true;
				},
			},
			{
				key: "Backspace",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					deleteSelected();
					return true;
				},
			},
			// Cmd+D — duplicate field via doc mutation
			{
				key: "d",
				meta: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const result = duplicateField(asUuid(loc.selectedUuid));
					/* A gate rejection was still handled by Nova (and may show a
					 * finding); falling through here would also open the browser's
					 * bookmark dialog after the user asked Nova to duplicate a field. */
					if (!result) return true;
					navigateToField(asUuid(result.newUuid));
					return true;
				},
			},
			// ArrowUp/ArrowDown — reorder within sibling level via doc mutation
			{
				key: "ArrowUp",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const { beforeUuid } = getFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!beforeUuid) return false;
					moveField(asUuid(loc.selectedUuid), { beforeUuid });
					return true;
				},
			},
			{
				key: "ArrowDown",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const { afterUuid } = getFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!afterUuid) return false;
					moveField(asUuid(loc.selectedUuid), { afterUuid });
					return true;
				},
			},
			// Shift+ArrowUp/Shift+ArrowDown — cross-level (indent/outdent) reorder.
			// `notifyMoveRename` pops the rename-dedup toast when a cross-parent
			// move collided with a sibling id and the reducer auto-renamed.
			{
				key: "ArrowUp",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const { up } = getCrossLevelFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!up) return false;
					const result = moveField(asUuid(loc.selectedUuid), {
						toParentUuid: up.toParentUuid,
						...(up.beforeUuid ? { beforeUuid: up.beforeUuid } : {}),
						...(up.afterUuid ? { afterUuid: up.afterUuid } : {}),
					});
					notifyMoveRename(result);
					return true;
				},
			},
			{
				key: "ArrowDown",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return false;
					const { down } = getCrossLevelFieldMoveTargets(
						docApi.getState(),
						asUuid(loc.selectedUuid),
					);
					if (!down) return false;
					const result = moveField(asUuid(loc.selectedUuid), {
						toParentUuid: down.toParentUuid,
						...(down.beforeUuid ? { beforeUuid: down.beforeUuid } : {}),
						...(down.afterUuid ? { afterUuid: down.afterUuid } : {}),
					});
					notifyMoveRename(result);
					return true;
				},
			},
			// Cmd+Z / Cmd+Shift+Z — undo/redo (not global: TipTap and CodeMirror
			// have their own undo stacks that should handle Cmd+Z when focused)
			{
				key: "z",
				meta: true,
				handler: () => {
					if (!canUndo) return false;
					undo();
					return true;
				},
			},
			{
				key: "z",
				meta: true,
				shift: true,
				handler: () => {
					if (!canRedo) return false;
					redo();
					return true;
				},
			},
		];
	}, [
		isReady,
		loc,
		docApi,
		setPending,
		select,
		transitionPreview,
		deleteSelected,
		undo,
		redo,
		canUndo,
		canRedo,
		duplicateField,
		moveField,
		previewing,
	]);
}
