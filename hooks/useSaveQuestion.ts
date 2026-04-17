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
import type { FieldPatch } from "@/lib/domain";

export function useSaveQuestion(
	uuid: Uuid | string | undefined,
): (field: string, value: string | null) => void {
	const { updateField } = useBlueprintMutations();

	return useCallback(
		(field: string, value: string | null) => {
			if (!uuid) return;
			// The `field` argument is an open string (driven by per-section
			// editors); we cast through FieldPatch so callers can target any
			// writable property without widening the mutation API.
			const patch = {
				[field]: value === "" || value === null ? undefined : value,
			} as FieldPatch;
			updateField(asUuid(uuid), patch);
		},
		[uuid, updateField],
	);
}
