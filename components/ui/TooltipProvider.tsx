/**
 * Root-level tooltip delay group provider.
 *
 * Wraps the app tree so all Base UI tooltips share a delay group: once the
 * first tooltip opens, adjacent tooltips open instantly (no re-waiting the
 * 400ms delay). The 400ms timeout controls how long the "instant" window
 * stays open after a tooltip closes.
 */

"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
	return (
		<Tooltip.Provider delay={400} closeDelay={0} timeout={400}>
			{children}
		</Tooltip.Provider>
	);
}
