/**
 * Hook that creates a save callback for TextEditable inline editors.
 *
 * Takes a field uuid directly and produces a `(field, value) => void`
 * function that mutates the blueprint via the doc store's `updateField`
 * action. Returns null outside of edit mode or when no uuid is provided.
 */

"use client";

import { useCallback } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { FieldPatch } from "@/lib/domain";
import { useCursorMode } from "@/lib/session/hooks";
import { useEditContext } from "./useEditContext";

/**
 * Returns a `(field, value) => void` callback for saving field properties,
 * or null if inline text editing is not available (wrong mode, no uuid).
 */
export function useTextEditSave(
	uuid: Uuid | string | undefined,
): ((field: string, value: string) => void) | null {
	const ctx = useEditContext();
	const cursorMode = useCursorMode();
	const { updateField } = useBlueprintMutations();

	const save = useCallback(
		(field: string, value: string) => {
			if (!uuid) return;
			// `field` is an open string (set by the calling inline editor).
			// FieldPatch is the union-wide partial the reducer accepts.
			const patch = { [field]: value === "" ? undefined : value } as FieldPatch;
			updateField(asUuid(uuid), patch);
		},
		[uuid, updateField],
	);

	if (!ctx || cursorMode !== "edit" || !uuid) return null;
	return save;
}
