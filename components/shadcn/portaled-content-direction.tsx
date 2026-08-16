"use client";

import { createContext, type ReactNode, useContext } from "react";

type ContentDirection = "ltr" | "rtl";

const PortaledContentDirectionContext = createContext<
	ContentDirection | undefined
>(undefined);

/**
 * Carries worker-content direction across React portals. A DOM `dir` scopes
 * inline preview content, but a popup rendered under document.body cannot
 * inherit it through the DOM tree.
 */
export function PortaledContentDirectionProvider({
	direction,
	children,
}: {
	readonly direction: ContentDirection;
	readonly children: ReactNode;
}) {
	return (
		<PortaledContentDirectionContext.Provider value={direction}>
			{children}
		</PortaledContentDirectionContext.Provider>
	);
}

export function usePortaledContentDirection(): ContentDirection | undefined {
	return useContext(PortaledContentDirectionContext);
}
