/**
 * EditContext — provides the identity of the currently-viewed form to
 * preview components so they can select the right slice of store state.
 *
 * Only carries positional identity (moduleIndex, formIndex) and rendering
 * mode. Components access blueprint data and mutation actions via
 * `useBuilderStore` directly — no prop drilling of engine/store references.
 */
"use client";
import { createContext, type ReactNode, useContext } from "react";

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
	return (
		<EditContext.Provider value={{ moduleIndex, formIndex, mode }}>
			{children}
		</EditContext.Provider>
	);
}

export function useEditContext(): EditContextValue | null {
	return useContext(EditContext);
}
