"use client";

import { useEffect, useState } from "react";

function isSameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function millisecondsUntilNextLocalDay(now: Date): number {
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	// Land just beyond the boundary so coarse browser clocks cannot reschedule
	// against the final millisecond of the old day. Constructing the next local
	// midnight also keeps 23/25-hour daylight-saving days correct.
	return Math.max(1, next.getTime() - now.getTime() + 25);
}

/**
 * The worker's current local calendar day, kept fresh while a screen remains
 * mounted. Activity can preserve Preview screens indefinitely, so a one-time
 * `new Date()` snapshot is not enough for interval labels or their filters.
 *
 * The midnight timer handles an open tab; focus and visibility resync cover
 * throttled background timers and device-clock changes. Same-day resyncs keep
 * the existing Date identity so consumers do not rerender unnecessarily.
 */
export function useLocalCalendarDay(): Date {
	const [day, setDay] = useState(() => new Date());

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const syncAndSchedule = () => {
			const now = new Date();
			setDay((current) => (isSameLocalDay(current, now) ? current : now));
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(syncAndSchedule, millisecondsUntilNextLocalDay(now));
		};
		const syncWhenVisible = () => {
			if (document.visibilityState === "visible") syncAndSchedule();
		};

		syncAndSchedule();
		window.addEventListener("focus", syncAndSchedule);
		document.addEventListener("visibilitychange", syncWhenVisible);
		return () => {
			if (timer !== undefined) clearTimeout(timer);
			window.removeEventListener("focus", syncAndSchedule);
			document.removeEventListener("visibilitychange", syncWhenVisible);
		};
	}, []);

	return day;
}
