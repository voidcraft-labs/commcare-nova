/**
 * Moments and the text CommCare HQ stores for each, UTC with six fraction
 * digits and `Z` (`dimagi/utils/parsing.py::json_format_datetime`). Vitest
 * holds `hqInstantText` and `caseDatetimeValue` to them
 * (`temporalValues.test.ts`), Preview's evaluation of the phone's stored
 * text holds `storedInstantOfText` to them
 * (`lib/preview/xpath/__tests__/storedInstant.test.ts`), and the proof
 * lane's expression family writes them as `stored-instants.json` for Core in
 * every device zone (`proof/native/core/StoredInstantRuntimeTest.java`) and
 * for HQ's own `adjust_datetimes` (`proof/hq/test_stored_datetime.py`).
 *
 * Each `text` is written out by hand, never computed from the function under
 * test. The device zones the lane runs (UTC, New York, Kolkata with its half
 * hour, Kiritimati at fourteen hours) put each moment on its own side of a
 * day: the first two are a moment whose UTC day is the day after the
 * device's (in New York) and one whose UTC day is the day before (in Kolkata
 * and Kiritimati).
 */
export interface HqInstantVector {
	readonly id: string;
	/** The moment, as an ISO 8601 UTC instant with milliseconds. */
	readonly instant: string;
	/** The text CommCare HQ stores for it. */
	readonly text: string;
}

export const HQ_INSTANT_VECTORS: readonly HqInstantVector[] = [
	{
		id: "utc-day-after-new-york",
		instant: "2026-01-02T03:30:00.000Z",
		text: "2026-01-02T03:30:00.000000Z",
	},
	{
		id: "utc-day-before-kolkata",
		instant: "2026-01-01T20:00:00.000Z",
		text: "2026-01-01T20:00:00.000000Z",
	},
	{
		id: "last-millisecond-before-utc-midnight",
		instant: "2026-01-01T23:59:59.999Z",
		text: "2026-01-01T23:59:59.999000Z",
	},
	{
		id: "before-new-york-spring-forward",
		instant: "2026-03-08T06:59:59.000Z",
		text: "2026-03-08T06:59:59.000000Z",
	},
	{
		id: "after-new-york-spring-forward",
		instant: "2026-03-08T07:00:00.000Z",
		text: "2026-03-08T07:00:00.000000Z",
	},
	{
		id: "new-york-repeated-hour-first",
		instant: "2026-11-01T05:30:00.000Z",
		text: "2026-11-01T05:30:00.000000Z",
	},
	{
		id: "new-york-repeated-hour-second",
		instant: "2026-11-01T06:30:00.000Z",
		text: "2026-11-01T06:30:00.000000Z",
	},
	{
		id: "before-1970",
		instant: "1969-07-20T20:17:40.250Z",
		text: "1969-07-20T20:17:40.250000Z",
	},
	{
		id: "utc-midnight",
		instant: "2026-01-02T00:00:00.000Z",
		text: "2026-01-02T00:00:00.000000Z",
	},
	// The UTC day after a device's last day of a month, of February in a
	// common and a leap year, and of a year (in New York); the UTC day before a
	// device's first day of March in a leap year, and of a year (in Kolkata).
	{
		id: "utc-day-after-month-end",
		instant: "2026-05-01T02:00:00.000Z",
		text: "2026-05-01T02:00:00.000000Z",
	},
	{
		id: "utc-day-after-february-end",
		instant: "2026-03-01T03:00:00.000Z",
		text: "2026-03-01T03:00:00.000000Z",
	},
	{
		id: "utc-day-after-leap-day",
		instant: "2024-03-01T02:00:00.000Z",
		text: "2024-03-01T02:00:00.000000Z",
	},
	{
		id: "utc-day-after-year-end",
		instant: "2027-01-01T03:00:00.000Z",
		text: "2027-01-01T03:00:00.000000Z",
	},
	{
		id: "utc-leap-day-before-device-march",
		instant: "2024-02-29T20:00:00.000Z",
		text: "2024-02-29T20:00:00.000000Z",
	},
	{
		id: "utc-day-before-device-new-year",
		instant: "2026-12-31T20:00:00.000Z",
		text: "2026-12-31T20:00:00.000000Z",
	},
];
