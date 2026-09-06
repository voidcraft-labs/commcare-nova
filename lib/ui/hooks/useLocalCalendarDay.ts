"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createLocalCalendarClock } from "../localCalendarClock";

/** The current local day, including midnight in a mounted Preview and
 * resumption after background throttling or a device-clock change. */
export function useLocalCalendarDay(): Date {
	const [clock] = useState(createLocalCalendarClock);
	const day = useSyncExternalStore(
		clock.subscribe,
		clock.getSnapshot,
		clock.getSnapshot,
	);
	useEffect(() => {
		const syncWhenVisible = () => {
			if (document.visibilityState === "visible") clock.sync();
		};
		window.addEventListener("focus", clock.sync);
		document.addEventListener("visibilitychange", syncWhenVisible);
		return () => {
			window.removeEventListener("focus", clock.sync);
			document.removeEventListener("visibilitychange", syncWhenVisible);
		};
	}, [clock]);
	return day;
}
