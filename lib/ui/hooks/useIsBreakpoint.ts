"use client";

import { useCallback, useSyncExternalStore } from "react";

type BreakpointMode = "min" | "max";
type BreakpointAxis = "width" | "height";

/**
 * Hook to detect whether the current viewport matches a given breakpoint rule.
 * Example:
 *   useIsBreakpoint("max", 768)   // true when width < 768
 *   useIsBreakpoint("min", 1024)  // true when width >= 1024
 *   useIsBreakpoint("max", 700, "height") // true on short windows
 */
export function useIsBreakpoint(
	mode: BreakpointMode = "max",
	breakpoint = 768,
	axis: BreakpointAxis = "width",
) {
	const query =
		mode === "min"
			? `(min-${axis}: ${breakpoint}px)`
			: `(max-${axis}: ${breakpoint - 1}px)`;
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const media = window.matchMedia(query);
			media.addEventListener("change", onStoreChange);
			return () => media.removeEventListener("change", onStoreChange);
		},
		[query],
	);
	const getSnapshot = useCallback(
		() => window.matchMedia(query).matches,
		[query],
	);
	const getServerSnapshot = useCallback(() => false, []);

	/* React checks the external snapshot during hydration/commit, before a
	 * passive effect can paint the wrong rail width or chat layout. */
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
