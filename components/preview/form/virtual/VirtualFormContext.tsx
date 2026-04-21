/**
 * Shared context for the virtualized form list.
 *
 * Carries the form-level identity + collapse-state API that every row
 * component needs. Without this, each row would need formUuid +
 * toggleCollapse as explicit props, cluttering `VirtualFormList`'s
 * row-dispatch switch.
 *
 * The context value is memoized on its inputs so rows don't re-render
 * from unrelated parent renders.
 */

"use client";
import { createContext, useContext, useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";

interface VirtualFormContextValue {
	/** The form's uuid — handed to drop-target `getData` builders so
	 *  they can correctly compute the moveField target parent when
	 *  the user drops onto the form root. */
	readonly formUuid: Uuid;
	/** Toggle a group's collapsed state. Rows call this from the
	 *  `GroupBracket` fold/unfold button. */
	readonly toggleCollapse: (uuid: Uuid) => void;
	/** Read the current collapsed state of a specific group. Used by
	 *  `GroupCloseRow` to self-hide when the parent is collapsed. */
	readonly isCollapsed: (uuid: Uuid) => boolean;
}

const VirtualFormContext = createContext<VirtualFormContextValue | null>(null);

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
