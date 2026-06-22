// components/preview/form/fields/geopoint/useInView.ts
//
// Tracks whether an element is at (or near) the viewport. The GPS picker
// uses this to mount its Google map ONLY while its field is on screen:
// browsers hard-cap simultaneous WebGL contexts (~16 in Chrome), so a form
// with several geopoint fields would otherwise spawn one live map each, blow
// past the cap, and the browser drops the oldest contexts — every map then
// renders blank. Mounting on-view and releasing off-view keeps the number of
// live maps to the handful actually visible.
//
// This is NOT bundle code-splitting — the Maps JS API still loads once via
// the shared loader; only the per-field map *instance* is created on demand.

"use client";
import { type RefObject, useEffect, useState } from "react";

/**
 * Returns true while `ref`'s element intersects the viewport expanded by
 * `rootMargin` (so the map mounts a little before it scrolls into view and
 * releases a little after it leaves). Falls back to always-true where
 * `IntersectionObserver` is unavailable (older/SSR environments) so the
 * map still renders.
 */
export function useInView(
	ref: RefObject<Element | null>,
	rootMargin = "300px",
): boolean {
	const [inView, setInView] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry) setInView(entry.isIntersecting);
			},
			{ rootMargin },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref, rootMargin]);

	return inView;
}
