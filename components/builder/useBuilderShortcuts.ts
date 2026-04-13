import { useMemo } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useBuilderEngine, useBuilderIsReady } from "@/hooks/useBuilder";
import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asUuid } from "@/lib/doc/types";
import {
	useDeleteSelectedQuestion,
	useUndoRedo,
} from "@/lib/routing/builderActions";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import type { Shortcut } from "@/lib/services/keyboardManager";
import {
	getCrossLevelMoveTargets,
	getQuestionMoveTargets,
} from "@/lib/services/questionNavigation";
import {
	flattenQuestionRefs,
	type QuestionRef,
} from "@/lib/services/questionPath";

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
 * fires mutations via uuid-first `useBlueprintMutations()`.
 */
export function useBuilderShortcuts(
	handleCursorModeChange: (mode: "pointer" | "edit") => void,
): Shortcut[] {
	const isReady = useBuilderIsReady();
	const loc = useLocation();
	const select = useSelect();
	const engine = useBuilderEngine();
	const { setPending } = useScrollIntoView();
	const deleteSelected = useDeleteSelectedQuestion();
	const { undo, redo } = useUndoRedo();
	const { duplicateQuestion, moveQuestion } = useBlueprintMutations();

	/* Assemble the current form so navigation/reorder helpers have the
	 * nested question tree. Returns `undefined` when not on a form screen.
	 * `useAssembledForm` short-circuits on a falsy uuid without subscribing
	 * to any entity map, so keystrokes off-form never trigger a rebuild. */
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const form = useAssembledForm(formUuid);

	return useMemo(() => {
		if (!isReady) return [];

		/** Build the flat ref list for the current form (depth-first walk,
		 *  used by Tab/Shift+Tab which crosses group boundaries). */
		const getFormRefs = (): QuestionRef[] | undefined =>
			form ? flattenQuestionRefs(form.questions) : undefined;

		/** Find the current question's index in the ref list by UUID. */
		const findCurrent = (refs: QuestionRef[]): number => {
			const selUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
			return refs.findIndex((r) => r.uuid === selUuid);
		};

		/** Build a path→uuid lookup from the flat refs list. */
		const buildPathToUuid = (refs: QuestionRef[]): Map<string, string> => {
			const map = new Map<string, string>();
			for (const r of refs) {
				map.set(r.path, r.uuid);
			}
			return map;
		};

		/** Navigate to a question by uuid — update selection via URL and
		 *  request a scroll to bring the question into view. */
		const navigateToQuestion = (uuid: string): void => {
			setPending(uuid, "smooth", false);
			select(asUuid(uuid));
		};

		return [
			// Escape — deselect / exit pointer mode
			{
				key: "Escape",
				handler: () => {
					if (engine.store.getState().cursorMode === "pointer") {
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
			// Tab / Shift+Tab — navigate questions (edit mode only)
			{
				key: "Tab",
				handler: () => {
					if (engine.store.getState().cursorMode !== "edit") return;
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const refs = getFormRefs();
					if (!refs?.length) return;
					const curIdx = findCurrent(refs);
					const next = refs[(curIdx + 1) % refs.length];
					navigateToQuestion(next.uuid);
				},
			},
			{
				key: "Tab",
				shift: true,
				handler: () => {
					if (engine.store.getState().cursorMode !== "edit") return;
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const refs = getFormRefs();
					if (!refs?.length) return;
					const curIdx = findCurrent(refs);
					const prev = refs[curIdx <= 0 ? refs.length - 1 : curIdx - 1];
					navigateToQuestion(prev.uuid);
				},
			},
			// Delete / Backspace — delete selected question
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
			// Cmd+D — duplicate question via doc mutation
			{
				key: "d",
				meta: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid) return;
					const result = duplicateQuestion(asUuid(loc.selectedUuid));
					if (!result) return;
					navigateToQuestion(result.newUuid);
				},
			},
			// ArrowUp/ArrowDown — reorder within sibling level via doc mutation
			{
				key: "ArrowUp",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid || !form) return;
					const refs = getFormRefs();
					if (!refs) return;
					const pathToUuid = buildPathToUuid(refs);
					const currentRef = refs.find((r) => r.uuid === loc.selectedUuid);
					if (!currentRef) return;
					const { beforePath } = getQuestionMoveTargets(
						form.questions,
						currentRef.path,
					);
					if (!beforePath) return;
					const beforeUuid = pathToUuid.get(beforePath);
					if (!beforeUuid) return;
					moveQuestion(asUuid(loc.selectedUuid), {
						beforeUuid: asUuid(beforeUuid),
					});
				},
			},
			{
				key: "ArrowDown",
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid || !form) return;
					const refs = getFormRefs();
					if (!refs) return;
					const pathToUuid = buildPathToUuid(refs);
					const currentRef = refs.find((r) => r.uuid === loc.selectedUuid);
					if (!currentRef) return;
					const { afterPath } = getQuestionMoveTargets(
						form.questions,
						currentRef.path,
					);
					if (!afterPath) return;
					const afterUuid = pathToUuid.get(afterPath);
					if (!afterUuid) return;
					moveQuestion(asUuid(loc.selectedUuid), {
						afterUuid: asUuid(afterUuid),
					});
				},
			},
			// Shift+ArrowUp/Shift+ArrowDown — cross-level (indent/outdent) reorder
			{
				key: "ArrowUp",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid || !form) return;
					const refs = getFormRefs();
					if (!refs) return;
					const pathToUuid = buildPathToUuid(refs);
					const currentRef = refs.find((r) => r.uuid === loc.selectedUuid);
					if (!currentRef) return;
					const { up } = getCrossLevelMoveTargets(
						form.questions,
						currentRef.path,
					);
					if (!up) return;
					/* Translate path-based targets to uuid-based targets.
					 * `targetParentPath === undefined` means root level → the form
					 * uuid is the parent. */
					const toParentUuid = up.targetParentPath
						? pathToUuid.get(up.targetParentPath)
						: formUuid;
					if (!toParentUuid) return;
					const beforeUuid = up.beforePath
						? pathToUuid.get(up.beforePath)
						: undefined;
					// phase-1b-task-10: cross-level move auto-rename notification is
					// synthesized by Task 10's path-to-path rewriter. Hook returns
					// void for now.
					moveQuestion(asUuid(loc.selectedUuid), {
						toParentUuid: asUuid(toParentUuid),
						...(beforeUuid ? { beforeUuid: asUuid(beforeUuid) } : {}),
					});
				},
			},
			{
				key: "ArrowDown",
				shift: true,
				handler: () => {
					if (loc.kind !== "form" || !loc.selectedUuid || !form) return;
					const refs = getFormRefs();
					if (!refs) return;
					const pathToUuid = buildPathToUuid(refs);
					const currentRef = refs.find((r) => r.uuid === loc.selectedUuid);
					if (!currentRef) return;
					const { down } = getCrossLevelMoveTargets(
						form.questions,
						currentRef.path,
					);
					if (!down) return;
					/* Same path→uuid translation as Shift+ArrowUp. */
					const toParentUuid = down.targetParentPath
						? pathToUuid.get(down.targetParentPath)
						: formUuid;
					if (!toParentUuid) return;
					const beforeUuid = down.beforePath
						? pathToUuid.get(down.beforePath)
						: undefined;
					// phase-1b-task-10: cross-level move auto-rename notification is
					// synthesized by Task 10's path-to-path rewriter. Hook returns
					// void for now.
					moveQuestion(asUuid(loc.selectedUuid), {
						toParentUuid: asUuid(toParentUuid),
						...(beforeUuid ? { beforeUuid: asUuid(beforeUuid) } : {}),
					});
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
		form,
		formUuid,
		engine,
		setPending,
		select,
		handleCursorModeChange,
		deleteSelected,
		undo,
		redo,
		duplicateQuestion,
		moveQuestion,
	]);
}
