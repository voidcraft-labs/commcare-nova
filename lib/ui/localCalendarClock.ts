function isSameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function millisecondsUntilNextLocalDay(now: Date): number {
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	// Construct local midnight, including 23/25-hour daylight-saving days.
	// Land beyond the boundary to tolerate coarse browser clocks.
	return Math.max(1, next.getTime() - now.getTime() + 25);
}

/** The local calendar owns its snapshot and one timer while subscribed.
 * Browser focus/visibility events call sync after throttling or a clock change. */
export function createLocalCalendarClock() {
	let day = new Date();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<() => void>();
	const cancelTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const sync = () => {
		cancelTimer();
		const now = new Date();
		if (!isSameLocalDay(day, now)) {
			day = now;
			for (const listener of listeners) listener();
		}
		if (listeners.size > 0) {
			timer = setTimeout(sync, millisecondsUntilNextLocalDay(now));
		}
	};
	return {
		getSnapshot: () => day,
		sync,
		subscribe(listener: () => void) {
			listeners.add(listener);
			if (listeners.size === 1) sync();
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) cancelTimer();
			};
		},
	};
}
