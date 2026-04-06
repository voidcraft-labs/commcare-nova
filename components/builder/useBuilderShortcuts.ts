import { useMemo } from "react";
import type { Builder, CursorMode } from "@/lib/services/builder";
import type { Shortcut } from "@/lib/services/keyboardManager";
import {
	flattenQuestionRefs,
	type QuestionRef,
} from "@/lib/services/questionPath";

/**
 * Builds a memoized keyboard shortcuts array for the builder layout.
 *
 * Returns an empty array when not in Ready phase.
 * When active, includes: Escape (deselect/exit pointer), 1/2/3 (switch cursor mode),
 * Tab/Shift+Tab (navigate questions in inspect mode), Delete/Backspace (delete question),
 * Cmd+D (duplicate), ArrowUp/ArrowDown (reorder), Cmd+Z/Cmd+Shift+Z (undo/redo).
 *
 * Handlers read from `builder` at call time (not at memo time), so the memo
 * only needs to refresh when the handler identity or mode changes — not on
 * every blueprint mutation.
 */
export function useBuilderShortcuts(
	builder: Builder,
	cursorMode: CursorMode,
	handleCursorModeChange: (mode: CursorMode) => void,
	handleDelete: () => void,
	onUndo: () => void,
	onRedo: () => void,
): Shortcut[] {
	const isReady = builder.isReady;

	return useMemo(() => {
		if (!isReady) return [];

		/** Get the flat question refs for the current form. */
		const getFormRefs = (): QuestionRef[] | undefined => {
			const sel = builder.selected;
			if (!sel || sel.formIndex === undefined) return undefined;
			const form =
				builder.blueprint?.modules[sel.moduleIndex]?.forms[sel.formIndex];
			return form ? flattenQuestionRefs(form.questions) : undefined;
		};

		/** Find the current question's index in the ref list by UUID. */
		const findCurrent = (refs: QuestionRef[]): number =>
			refs.findIndex((r) => r.uuid === builder.selected?.questionUuid);

		return [
			// Escape — deselect / exit pointer mode
			{
				key: "Escape",
				handler: () => {
					if (cursorMode === "pointer") {
						handleCursorModeChange("inspect");
						return;
					}
					if (builder.selected) {
						builder.select();
						return;
					}
				},
			},
			// 1/2/3 — switch cursor mode
			{ key: "1", handler: () => handleCursorModeChange("pointer") },
			{ key: "2", handler: () => handleCursorModeChange("text") },
			{ key: "3", handler: () => handleCursorModeChange("inspect") },
			// Tab / Shift+Tab — navigate questions (inspect mode only; text mode uses Tab for text fields)
			{
				key: "Tab",
				handler: () => {
					if (cursorMode !== "inspect") return;
					const sel = builder.selected;
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
					if (cursorMode !== "inspect") return;
					const sel = builder.selected;
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
					if (builder.selected?.type === "question") handleDelete();
				},
			},
			{
				key: "Backspace",
				handler: () => {
					if (builder.selected?.type === "question") handleDelete();
				},
			},
			// Cmd+D — duplicate
			{
				key: "d",
				meta: true,
				handler: () => {
					const sel = builder.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					const mb = builder.mb;
					if (!mb) return;
					const { newPath, newUuid } = mb.duplicateQuestion(
						sel.moduleIndex,
						sel.formIndex,
						sel.questionPath,
					);
					builder.notifyBlueprintChanged();
					builder.navigateTo({
						type: "question",
						moduleIndex: sel.moduleIndex,
						formIndex: sel.formIndex,
						questionPath: newPath,
						questionUuid: newUuid,
					});
				},
			},
			// ArrowUp/ArrowDown — reorder
			{
				key: "ArrowUp",
				handler: () => {
					const sel = builder.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					const mb = builder.mb;
					if (!mb) return;
					const refs = getFormRefs();
					if (!refs) return;
					const curIdx = findCurrent(refs);
					if (curIdx <= 0) return;
					mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, {
						beforePath: refs[curIdx - 1].path,
					});
					builder.notifyBlueprintChanged();
				},
			},
			{
				key: "ArrowDown",
				handler: () => {
					const sel = builder.selected;
					if (
						!sel ||
						sel.type !== "question" ||
						sel.formIndex === undefined ||
						!sel.questionPath
					)
						return;
					const mb = builder.mb;
					if (!mb) return;
					const refs = getFormRefs();
					if (!refs) return;
					const curIdx = findCurrent(refs);
					if (curIdx < 0 || curIdx >= refs.length - 1) return;
					mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, {
						afterPath: refs[curIdx + 1].path,
					});
					builder.notifyBlueprintChanged();
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
	}, [
		isReady,
		builder,
		cursorMode,
		handleCursorModeChange,
		handleDelete,
		onUndo,
		onRedo,
	]);
}
