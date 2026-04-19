/**
 * useEntryActivation — per-section pending-activation state for the
 * declarative editor.
 *
 * When a user clicks the "Add Property" pill for a hidden-but-addable
 * entry, the section needs to render that entry's editor in autoFocus
 * mode (so the user can immediately type). This hook owns the pending
 * key. The scope is `${fieldUuid}:${section}` so two effects are
 * automatic:
 *
 *   1. Switching the selected field clears pending — you don't carry
 *      "I just added a hint" state across field selections.
 *   2. Two sections (Logic + UI) can each have their own pending key
 *      simultaneously — clicking "Add Hint" in UI doesn't clear a
 *      "pending validate" in Logic.
 *
 * Replaces the legacy `useAddableField` from contextual/shared.ts. Same
 * shape, scoped name, and clearer semantics.
 */
"use client";
import { useCallback, useState } from "react";

/** The three editor sections that can each independently hold an activation. */
export type EditorSectionName = "data" | "logic" | "ui";

export type EntryActivation = {
	/** True when `key` is pending for this scope. */
	pending: (key: string) => boolean;
	/** Mark `key` as pending; previous pending (if any) is replaced. */
	activate: (key: string) => void;
	/** Reset pending. */
	clear: () => void;
};

export function useEntryActivation(
	fieldUuid: string,
	section: EditorSectionName,
): EntryActivation {
	const scope = `${fieldUuid}:${section}`;
	const [state, setState] = useState<{ scope: string; key: string } | null>(
		null,
	);

	const pending = useCallback(
		(key: string) => state?.scope === scope && state.key === key,
		[state, scope],
	);
	const activate = useCallback(
		(key: string) => setState({ scope, key }),
		[scope],
	);
	const clear = useCallback(() => setState(null), []);

	return { pending, activate, clear };
}
