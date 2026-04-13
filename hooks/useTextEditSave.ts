/**
 * Hook that creates a save callback for TextEditable inline editors.
 *
 * Combines the edit context (moduleIndex, formIndex) with a question path
 * to produce a `(field, value) => void` function that mutates the blueprint
 * via the store's updateQuestion action. Returns null outside of edit mode
 * or when no context is available.
 */

import { useCallback } from "react";
import { useBuilderStore } from "@/hooks/useBuilder";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { QuestionPath } from "@/lib/services/questionPath";
import { useEditContext } from "./useEditContext";

/**
 * Returns a `(field, value) => void` callback for saving question fields,
 * or null if inline text editing is not available (wrong mode, no context).
 */
export function useTextEditSave(
	questionPath: QuestionPath | undefined,
): ((field: string, value: string) => void) | null {
	const ctx = useEditContext();
	const cursorMode = useBuilderStore((s) => s.cursorMode);
	const { updateQuestion } = useBlueprintMutations();

	const save = useCallback(
		(field: string, value: string) => {
			if (!ctx || !questionPath) return;
			updateQuestion(ctx.moduleIndex, ctx.formIndex, questionPath, {
				[field]: value === "" ? null : value,
			});
		},
		[ctx, questionPath, updateQuestion],
	);

	if (!ctx || cursorMode !== "edit" || !questionPath) return null;
	return save;
}
