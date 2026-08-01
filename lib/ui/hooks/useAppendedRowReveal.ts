/**
 * Bring a row appended to the bottom of a list into view.
 *
 * An Add control sits under its own list, so the list grows ABOVE it and in a
 * dialog — where the body is a fixed-height scroll region — the new row lands
 * under the fold. The only thing that visibly changes is the button shifting
 * down a notch, so the press reads as "nothing happened" until you think to
 * scroll. Revealing the row is what makes the press legible.
 *
 * Aligned to `start`, not `nearest`: for an element below the fold `nearest`
 * aligns its BOTTOM edge with the scrollport's, which for a row taller than the
 * scrollport carries its heading off the top — the opposite of the point. A
 * short list simply cannot scroll that far and stops at the bottom, which shows
 * the new row anyway.
 *
 * Unlike [useRemovedRowFocus] this watches the LENGTH rather than arming an
 * intent at the gesture. An armed intent has to be consumed on every render to
 * avoid outliving a refused gesture, and any render landing between the arming
 * click and the appended commit consumes it against a length that has not grown
 * yet — the scroll is then simply skipped, which is exactly what the third and
 * later presses did. Comparing lengths has no such window. It is safe here
 * because these lists are local draft state that only the author's own Add
 * grows; a list that can also grow from a peer or a fetch wants the intent.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";

export function useAppendedRowReveal(count: number): {
	/** Attach to each row's outermost element, by its index in the list. */
	readonly register: (index: number) => (el: HTMLElement | null) => void;
} {
	const rows = useRef<(HTMLElement | null)[]>([]);
	const previous = useRef(count);

	// Un-keyed so the comparison is made against the render that just landed,
	// whatever caused it.
	useEffect(() => {
		const grew = count > previous.current;
		previous.current = count;
		if (!grew) return;
		const target = rows.current[count - 1];
		if (target === null || target === undefined) return;
		const reducedMotion =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		target.scrollIntoView?.({
			behavior: reducedMotion ? "auto" : "smooth",
			block: "start",
		});
	});

	const register = useCallback(
		(index: number) => (el: HTMLElement | null) => {
			rows.current[index] = el;
		},
		[],
	);

	return { register };
}
