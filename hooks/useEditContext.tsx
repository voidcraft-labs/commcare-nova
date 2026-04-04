"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Builder, CursorMode } from "@/lib/services/builder";

export type EditMode = "edit" | "test";

interface EditContextValue {
	builder: Builder;
	moduleIndex: number;
	formIndex: number;
	mode: EditMode;
	/** Current cursor mode — undefined when PreviewShell is used standalone (no builder). */
	cursorMode?: CursorMode;
}

const EditContext = createContext<EditContextValue | null>(null);

export function EditContextProvider({
	builder,
	moduleIndex,
	formIndex,
	mode,
	cursorMode,
	children,
}: EditContextValue & { children: ReactNode }) {
	return (
		<EditContext.Provider
			value={{ builder, moduleIndex, formIndex, mode, cursorMode }}
		>
			{children}
		</EditContext.Provider>
	);
}

export function useEditContext(): EditContextValue | null {
	return useContext(EditContext);
}
