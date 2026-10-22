// lib/preview/hooks/useViewerPosition.ts
//
// The running list's location watch behind `here()`. A list whose Results
// show a column that reads `here()` starts a watch when it mounts, unless
// the browser refused this session or has no location; the list's note then
// offers the way forward. A mount while an ask is still unanswered watches
// again, so the answer reaches a list that is on screen. The watch stops once a position is good enough or
// the list unmounts, so each fresh list watches again from the position the
// last one showed, as Android's `EntitySelectActivity` clears its handler's
// "good enough" on every fresh list.

"use client";

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { watchGeolocation } from "@/components/preview/form/fields/geopoint/geolocation";
import { positionSettles } from "@/lib/preview/engine/viewerLocation";
import {
	type ViewerPositionStatus,
	viewerPositionStore,
	watchesOnMount,
} from "@/lib/session/viewerPosition";

/**
 * Watch the viewer's position while `active` (the list on screen reads
 * `here()` in Results). `share` starts the watch again from a person's
 * click: the first ask when the browser has not answered, or another try
 * after it could not find a position.
 */
export function useViewerPositionWatch(active: boolean): {
	status: ViewerPositionStatus;
	share: () => void;
} {
	const status = useStore(viewerPositionStore, (state) => state.status);
	const stopRef = useRef<(() => void) | undefined>(undefined);

	const stop = useCallback(() => {
		stopRef.current?.();
		stopRef.current = undefined;
	}, []);

	const start = useCallback(() => {
		stop();
		viewerPositionStore.getState().asked();
		let settled = false;
		let stopWatch: (() => void) | undefined;
		stopWatch = watchGeolocation({
			onFix: (fix) => {
				viewerPositionStore.getState().reported(fix);
				if (positionSettles(fix.accuracy)) {
					settled = true;
					stopWatch?.();
				}
			},
			onFailure: (reason) => viewerPositionStore.getState().failed(reason),
		});
		/* A position good enough to stop on can arrive before the watch hands
		 * back its stop. */
		if (settled) stopWatch();
		stopRef.current = stopWatch;
	}, [stop]);

	useEffect(() => {
		if (!active) return;
		if (watchesOnMount(viewerPositionStore.getState().status)) start();
		return stop;
	}, [active, start, stop]);

	const share = useCallback(() => {
		if (active) start();
	}, [active, start]);

	return { status, share };
}

/** The count of position moves a list that reads `here()` keys its read on. */
export function useViewerPositionMoves(): number {
	return useStore(viewerPositionStore, (state) => state.moves);
}
