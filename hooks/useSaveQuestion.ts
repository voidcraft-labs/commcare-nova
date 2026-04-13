/**
 * Shared hook for saving a single question field. Used by all contextual
 * editor sections (UI, Logic, Data, Footer) to avoid duplicating the same
 * mutation boilerplate. Converts empty strings to undefined (removal).
 *
 * Takes a uuid directly — callers pass `question.uuid` from
 * `useSelectedQuestion()`. Returns a no-op when the uuid is falsy
 * (callers gate on selection first).
 */

import { useCallback } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asUuid, type Uuid } from "@/lib/doc/types";

export function useSaveQuestion(
	uuid: Uuid | string | undefined,
): (field: string, value: string | null) => void {
	const { updateQuestion } = useBlueprintMutations();

	return useCallback(
		(field: string, value: string | null) => {
			if (!uuid) return;
			updateQuestion(asUuid(uuid), {
				[field]: value === "" || value === null ? undefined : value,
			});
		},
		[uuid, updateQuestion],
	);
}
