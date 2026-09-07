"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
	const media = window.matchMedia(QUERY);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}

function getSnapshot() {
	return window.matchMedia(QUERY).matches;
}

/** Motion's hook snapshots this preference at mount. Builder choreography
 * must also settle animations when the device preference changes in flight. */
export function useReducedMotionPreference() {
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
