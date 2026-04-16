/**
 * EditContext — provides the identity of the currently-viewed form to
 * preview components so they can select the right slice of store state.
 *
 * Only carries positional identity (moduleIndex, formIndex) and rendering
 * mode. Components access blueprint data and mutation actions via doc store
 * hooks directly — no prop drilling of engine/store references.
 */
"use client";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export type EditMode = "edit" | "test";

interface EditContextValue {
	moduleIndex: number;
	formIndex: number;
	mode: EditMode;
}

const EditContext = createContext<EditContextValue | null>(null);

export function EditContextProvider({
	moduleIndex,
	formIndex,
	mode,
	children,
}: EditContextValue & { children: ReactNode }) {
	/* Memoize the context value so consumer components only re-render when
	 * the positional identity or mode actually changes — not on every parent
	 * render. Without this, FormScreen re-renders (from entity map changes)
	 * would cascade through all 488+ context consumers in the form tree. */
	const value = useMemo(
		() => ({ moduleIndex, formIndex, mode }),
		[moduleIndex, formIndex, mode],
	);
	return <EditContext.Provider value={value}>{children}</EditContext.Provider>;
}

export function useEditContext(): EditContextValue | null {
	return useContext(EditContext);
}
