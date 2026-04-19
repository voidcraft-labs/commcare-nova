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
 * Only one key can be pending per scope at any moment — calling `activate`
 * with a new key replaces the prior one. This matches the UX constraint that
 * each section exposes at most one "Add Property" action at a time.
 */
"use client";
import { useCallback, useMemo, useState } from "react";

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
	// UUIDs are RFC 4122 (hex + hyphens only) so `:` is a safe delimiter —
	// no uuid can embed a colon that would alias a different (uuid, section) pair.
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

	// Stabilize the returned object so memoized consumers (React.memo / spread
	// onto props) don't rerender when only the `pending` closure identity
	// changes — useMemo recomputes only when one of the three callbacks does.
	return useMemo(
		() => ({ pending, activate, clear }),
		[pending, activate, clear],
	);
}
