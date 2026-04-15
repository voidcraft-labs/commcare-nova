/**
 * Shared context for the virtualized form list.
 *
 * Carries the form-level identity + mutation callbacks that every row
 * component needs. Without this, each row would need formUuid as an
 * explicit prop, cluttering `VirtualFormList`'s row-dispatch switch.
 *
 * The context value is created once by `VirtualFormList` and is reference-
 * stable (memoized on formUuid + toggle), so rows don't re-render on
 * unrelated parent renders.
 */

"use client";
import { createContext, useContext, useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";

// ── Constants ──────────────────────────────────────────────────────────

/** dnd-kit group key for root-level (form-uuid-children) sortables. */
export const ROOT_GROUP = "__root__";

/** Suffix appended to a group/repeat uuid to form its dnd-kit group key.
 *  Matches the `useDroppable` id used by empty-container rows so the
 *  `move()` helper can route drops correctly. */
export const CONTAINER_SUFFIX = ":container";

// ── Context value ─────────────────────────────────────────────────────

interface VirtualFormContextValue {
	/** The form's uuid — used to discriminate root-level from nested
	 *  sortables and to compose container ids. */
	readonly formUuid: Uuid;
	/** Toggle a group's collapsed state. Rows call this from the
	 *  `GroupBracket` fold/unfold button. */
	readonly toggleCollapse: (uuid: Uuid) => void;
	/** Read the current collapsed state of a specific group. Used by
	 *  `GroupBracket` to pick the chevron direction. */
	readonly isCollapsed: (uuid: Uuid) => boolean;
}

const VirtualFormContext = createContext<VirtualFormContextValue | null>(null);

// ── Provider + hook ───────────────────────────────────────────────────

interface VirtualFormProviderProps {
	formUuid: Uuid;
	toggleCollapse: (uuid: Uuid) => void;
	isCollapsed: (uuid: Uuid) => boolean;
	children: React.ReactNode;
}

export function VirtualFormProvider({
	formUuid,
	toggleCollapse,
	isCollapsed,
	children,
}: VirtualFormProviderProps) {
	// Memoize so consumer rows don't see the context reference change on
	// every parent render — the identities of the callback args are
	// expected stable (VirtualFormList defines them with useCallback).
	const value = useMemo(
		() => ({ formUuid, toggleCollapse, isCollapsed }),
		[formUuid, toggleCollapse, isCollapsed],
	);
	return (
		<VirtualFormContext.Provider value={value}>
			{children}
		</VirtualFormContext.Provider>
	);
}

export function useVirtualFormContext(): VirtualFormContextValue {
	const ctx = useContext(VirtualFormContext);
	if (!ctx) {
		throw new Error(
			"useVirtualFormContext must be used inside <VirtualFormProvider>",
		);
	}
	return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Compute the dnd-kit group key for a sortable living at `parentUuid` in a
 * form whose root is `formUuid`. Root-level children share the ROOT_GROUP
 * bucket; nested children use the parent's container suffix.
 */
export function groupKeyForParent(parentUuid: Uuid, formUuid: Uuid): string {
	return parentUuid === formUuid
		? ROOT_GROUP
		: `${parentUuid}${CONTAINER_SUFFIX}`;
}
