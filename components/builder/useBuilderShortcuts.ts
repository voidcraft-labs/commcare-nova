import { useMemo } from "react";
import type { BuilderEngine } from "@/lib/services/builderEngine";
import type { Shortcut } from "@/lib/services/keyboardManager";
import { assembleForm } from "@/lib/services/normalizedState";
import {
	getCrossLevelMoveTargets,
	getQuestionMoveTargets,
} from "@/lib/services/questionNavigation";
import {
	flattenQuestionRefs,
	type QuestionRef,
	qpath,
	qpathId,
} from "@/lib/services/questionPath";

/**
 * Builds a memoized keyboard shortcuts array for the builder layout.
 *
 * Returns an empty array when not in Ready phase.
 * When active, includes: Escape (deselect/exit pointer), V/E (switch cursor mode),
 * Tab/Shift+Tab (navigate questions in edit mode), Delete/Backspace (delete question),
 * Cmd+D (duplicate), ArrowUp/ArrowDown (reorder), Cmd+Z/Cmd+Shift+Z (undo/redo).
 *
 * All handlers read from the store at call time — the memo only refreshes when
 * the handler identity changes, not on state transitions like cursor mode or
 * blueprint mutations.
 */
export function useBuilderShortcuts(
	builder: BuilderEngine,
	handleCursorModeChange: (mode: "pointer" | "edit") => void,
	handleDelete: () => void,
	onUndo: () => void,
	onRedo: () => void,
): Shortcut[] {
	const isReady = builder.isReady;

	return useMemo(() => {
		if (!isReady) return [];

		/** Assemble the current form from normalized state. */
		const getAssembledForm = () => {
			const s = builder.store.getState();
			const sel = s.selected;
			if (!sel || sel.formIndex === undefined) return undefined;
			const moduleId = s.moduleOrder[sel.moduleIndex];
			if (!moduleId) return undefined;
			const formId = s.formOrder[moduleId]?.[sel.formIndex];
			if (!formId) return undefined;
			return assembleForm(
				s.forms[formId],
				formId,
				s.questions,
				s.questionOrder,
			);
		};

		/** Get the flat question refs for the current form (depth-first,
		 *  used by Tab/Shift+Tab navigation which should cross group levels). */
		const getFormRefs = (): QuestionRef[] | undefined => {
			const form = getAssembledForm();
			return form ? flattenQuestionRefs(form.questions) : undefined;
		};

		/** Find the current question's index in the ref list by UUID. */
		const findCurrent = (refs: QuestionRef[]): number =>
			refs.findIndex(
				(r) => r.uuid === builder.store.getState().selected?.questionUuid,
			);

		return [
			// Escape — deselect / exit pointer mode
			{
				key: "Escape",
				handler: () => {
					if (builder.store.getState().cursorMode === "pointer") {
						handleCursorModeChange("edit");
						return;
					}
					if (builder.store.getState().selected) {
						builder.select();
						return;
					}
				},
			},
			// V/E — switch cursor mode (Figma-style single-key shortcuts,
			// suppressed when an input/editor is focused via keyboardManager)
			{ key: "v", handler: () => handleCursorModeChange("pointer") },
			{ key: "e", handler: () => handleCursorModeChange("edit") },
			// Tab / Shift+Tab — navigate questions (inspect mode only; text mode uses Tab for text fields)
			{
				key: "Tab",
				handler: () => {
					if (builder.store.getState().cursorMode !== "edit") return;
					const sel = builder.store.getState().selected;
					if (!sel) return;
					const refs = getFormRefs();
					if (!refs?.length) return;
					const curIdx = findCurrent(refs);
					const next = refs[(curIdx + 1) % refs.length];
					builder.navigateTo({
						type: "question",
						moduleIndex: sel.moduleIndex,
						formIndex: sel.formIndex,
						questionPath: next.path,
						questionUuid: next.uuid,
					});
				},
			},
			{
				key: "Tab",
				shift: true,
				handler: () => {
					if (builder.store.getState().cursorMode !== "edit") return;
					const sel = builder.store.getState().selected;
					if (!sel) return;
					const refs = getFormRefs();
					if (!refs?.length) return;
					const curIdx = findCurrent(refs);
					const prev = refs[curIdx <= 0 ? refs.length - 1 : curIdx - 1];
					builder.navigateTo({
						type: "question",
						moduleIndex: sel.moduleIndex,
						formIndex: sel.formIndex,
						questionPath: prev.path,
						questionUuid: prev.uuid,
					});
				},
			},
			// Delete / Backspace — delete selected question
			{
				key: "Delete",
				handler: () => {
					if (builder.store.getState().selected?.type === "question")
						handleDelete();
				},
			},
			{
				key: "Backspace",
				handler: () => {
					if (builder.store.getState().selected?.type === "question")
						handleDelete();
				},
			},
			// Cmd+D — duplicate question via store action
			{
				key: "d",
				meta: true,
				handler: () => {
					const s = builder.store.getState();
					const sel = s.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					if (s.moduleOrder.length === 0) return;
					const { newPath, newUuid } = s.duplicateQuestion(
						sel.moduleIndex,
						sel.formIndex,
						sel.questionPath,
					);
					builder.navigateTo({
						type: "question",
						moduleIndex: sel.moduleIndex,
						formIndex: sel.formIndex,
						questionPath: newPath,
						questionUuid: newUuid,
					});
				},
			},
			// ArrowUp/ArrowDown — reorder within sibling level via store action
			{
				key: "ArrowUp",
				handler: () => {
					const s = builder.store.getState();
					const sel = s.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					if (s.moduleOrder.length === 0) return;
					const form = getAssembledForm();
					if (!form) return;
					const { beforePath } = getQuestionMoveTargets(
						form.questions,
						sel.questionPath,
					);
					if (!beforePath) return;
					s.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, {
						beforePath,
					});
				},
			},
			{
				key: "ArrowDown",
				handler: () => {
					const s = builder.store.getState();
					const sel = s.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					if (s.moduleOrder.length === 0) return;
					const form = getAssembledForm();
					if (!form) return;
					const { afterPath } = getQuestionMoveTargets(
						form.questions,
						sel.questionPath,
					);
					if (!afterPath) return;
					s.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, {
						afterPath,
					});
				},
			},
			// Shift+ArrowUp/Shift+ArrowDown — cross-level (indent/outdent) reorder
			{
				key: "ArrowUp",
				shift: true,
				handler: () => {
					const s = builder.store.getState();
					const sel = s.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					if (s.moduleOrder.length === 0) return;
					const form = getAssembledForm();
					if (!form) return;
					const { up } = getCrossLevelMoveTargets(
						form.questions,
						sel.questionPath,
					);
					if (!up) return;
					const { direction: _, ...opts } = up;
					s.moveQuestion(
						sel.moduleIndex,
						sel.formIndex,
						sel.questionPath,
						opts,
					);
					/* Navigate to new path — scrolls into view after cross-level move */
					const newPath = qpath(qpathId(sel.questionPath), up.targetParentPath);
					builder.navigateTo({
						...sel,
						questionPath: newPath,
					});
				},
			},
			{
				key: "ArrowDown",
				shift: true,
				handler: () => {
					const s = builder.store.getState();
					const sel = s.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					if (s.moduleOrder.length === 0) return;
					const form = getAssembledForm();
					if (!form) return;
					const { down } = getCrossLevelMoveTargets(
						form.questions,
						sel.questionPath,
					);
					if (!down) return;
					const { direction: _, ...opts } = down;
					s.moveQuestion(
						sel.moduleIndex,
						sel.formIndex,
						sel.questionPath,
						opts,
					);
					const newPath = qpath(
						qpathId(sel.questionPath),
						down.targetParentPath,
					);
					builder.navigateTo({
						...sel,
						questionPath: newPath,
					});
				},
			},
			// Cmd+Z / Cmd+Shift+Z — undo/redo
			{
				key: "z",
				meta: true,
				global: true,
				handler: onUndo,
			},
			{
				key: "z",
				meta: true,
				shift: true,
				global: true,
				handler: onRedo,
			},
		];
	}, [isReady, builder, handleCursorModeChange, handleDelete, onUndo, onRedo]);
}
