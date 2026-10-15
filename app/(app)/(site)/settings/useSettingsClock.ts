"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const options: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	year: "numeric",
};
const utcDateFormatter = new Intl.DateTimeFormat("en-GB", {
	...options,
	timeZone: "UTC",
});
const localDateFormatter = new Intl.DateTimeFormat("en-GB", options);

/** The server and hydration render share one serialized clock and UTC date.
 * Once hydrated, dates and relative labels use the viewer's current environment. */
export function useSettingsClock(initialNow: number) {
	const hydrated = useSyncExternalStore(
		subscribe,
		clientSnapshot,
		serverSnapshot,
	);
	return {
		now: hydrated ? Date.now() : initialNow,
		dateFormatter: hydrated ? localDateFormatter : utcDateFormatter,
	};
}
export type SettingsClock = ReturnType<typeof useSettingsClock>;
