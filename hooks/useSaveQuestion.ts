/**
 * Shared hook for saving a single question field. Used by all contextual
 * editor sections (UI, Logic, Data, Footer) to avoid duplicating the same
 * mutation boilerplate. Converts empty strings to null (removal).
 *
 * Reads selection from the store — no props needed. Throws if called
 * without an active question selection (callers gate on selection first).
 */

import { useCallback } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useBuilderStore } from "./useBuilder";

export function useSaveQuestion(): (
	field: string,
	value: string | null,
) => void {
	const selected = useBuilderStore((s) => s.selected);
	const { updateQuestion } = useBlueprintMutations();

	return useCallback(
		(field: string, value: string | null) => {
			if (
				!selected ||
				selected.formIndex === undefined ||
				!selected.questionPath
			)
				return;
			updateQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				{ [field]: value === "" ? null : value },
			);
		},
		[selected, updateQuestion],
	);
}
