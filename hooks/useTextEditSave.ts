/**
 * Hook that creates a save callback for TextEditable inline editors.
 *
 * Combines the edit context (builder, module, form) with a question path
 * to produce a `(field, value) => void` function that mutates the blueprint.
 * Returns null outside of text mode or when no context is available.
 */

import { useCallback } from "react";
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

	const save = useCallback(
		(field: string, value: string) => {
			if (!ctx || !questionPath) return;
			const mb = ctx.builder.mb;
			if (!mb) return;
			mb.updateQuestion(ctx.moduleIndex, ctx.formIndex, questionPath, {
				[field]: value === "" ? null : value,
			});
			ctx.builder.notifyBlueprintChanged();
		},
		[ctx, questionPath],
	);

	if (!ctx || ctx.cursorMode !== "text" || !questionPath) return null;
	return save;
}
