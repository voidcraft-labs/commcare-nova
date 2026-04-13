/**
 * Hook that creates a save callback for TextEditable inline editors.
 *
 * Takes a question uuid directly and produces a `(field, value) => void`
 * function that mutates the blueprint via the doc store's updateQuestion
 * action. Returns null outside of edit mode or when no uuid is provided.
 */

import { useCallback } from "react";
import { useBuilderStore } from "@/hooks/useBuilder";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useEditContext } from "./useEditContext";

/**
 * Returns a `(field, value) => void` callback for saving question fields,
 * or null if inline text editing is not available (wrong mode, no uuid).
 */
export function useTextEditSave(
	uuid: Uuid | string | undefined,
): ((field: string, value: string) => void) | null {
	const ctx = useEditContext();
	const cursorMode = useBuilderStore((s) => s.cursorMode);
	const { updateQuestion } = useBlueprintMutations();

	const save = useCallback(
		(field: string, value: string) => {
			if (!uuid) return;
			updateQuestion(asUuid(uuid), {
				[field]: value === "" ? undefined : value,
			});
		},
		[uuid, updateQuestion],
	);

	if (!ctx || cursorMode !== "edit" || !uuid) return null;
	return save;
}
