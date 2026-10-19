// lib/preview/xpath/coreDays.ts
//
// CommCare Core's own day arithmetic, computed from this realm's zone history
// exactly as `org/javarosa/core/model/utils/DateUtils.java` computes it from
// the device's. Core counts days from `EPOCH_TIME`, the device-zone midnight
// of 1970-01-01 fixed when `DateUtils` loads, in fixed 24-hour days with
// half-day rounding. Where a zone's offset today differs from its 1970 offset
// by more than twelve hours (Pacific/Kiritimati, Apia, Enderbury, Fakaofo,
// Kwajalein) that count is one less than the calendar's, and `date(n)` shifts
// with it, so the two still round-trip on the device. Preview plays the device
// in the viewer's zone and mirrors the quirk.
//
// Every function reads the realm's zone at the call: a browser page keeps one
// zone, and a test that assigns `process.env.TZ` sees the new one.

const DAY = 86_400_000;

/** A wall clock, its month zero-based as JavaScript's `Date` counts it. */
export interface WallClock {
	readonly year: number;
	readonly monthIndex: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
}

/**
 * The instant `java.util.Calendar` gives a wall clock in this realm's zone
 * (`DateUtils.getDate(DateFields, String)` sets each field on a lenient
 * `GregorianCalendar`). Java resolves a wall clock through
 * `sun.util.calendar.ZoneInfo.getOffsetsByWall`, which reads each transition
 * at its UTC instant plus the offset that begins there: a repeated wall clock
 * takes the new offset, its LATER occurrence, and a skipped one takes the old
 * offset, moving forward by the gap.
 *
 * JavaScript's `setHours` agrees in a gap and takes the EARLIER occurrence in
 * an overlap, so the candidates are tested here and the latest one kept; the
 * `Date` setters answer only when no candidate exists. Authoring stamps a
 * picked wall clock at its earlier occurrence instead
 * (`lib/domain/temporalValues.ts::zoneDesignatorForWallTime`); the two
 * policies answer different questions and stay separate.
 */
export function javaWallInstant(wall: WallClock): number {
	const asUtc = new Date(0);
	asUtc.setUTCFullYear(wall.year, wall.monthIndex, wall.day);
	asUtc.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond);
	const wallUtc = asUtc.getTime();
	let latest: number | null = null;
	for (const probe of [wallUtc - DAY, wallUtc, wallUtc + DAY]) {
		const candidate = wallUtc + new Date(probe).getTimezoneOffset() * 60_000;
		if (!showsWallClock(candidate, wall)) continue;
		if (latest === null || candidate > latest) latest = candidate;
	}
	if (latest !== null) return latest;
	const forward = new Date(0);
	forward.setFullYear(wall.year, wall.monthIndex, wall.day);
	forward.setHours(wall.hour, wall.minute, wall.second, wall.millisecond);
	return forward.getTime();
}

function showsWallClock(instant: number, wall: WallClock): boolean {
	const local = new Date(instant);
	return (
		local.getFullYear() === wall.year &&
		local.getMonth() === wall.monthIndex &&
		local.getDate() === wall.day &&
		local.getHours() === wall.hour &&
		local.getMinutes() === wall.minute &&
		local.getSeconds() === wall.second &&
		local.getMilliseconds() === wall.millisecond
	);
}

/** The UTC fields of a calendar day held as days since 1970-01-01. */
function calendarFields(calendarDays: number): WallClock {
	const date = new Date(calendarDays * DAY);
	return {
		year: date.getUTCFullYear(),
		monthIndex: date.getUTCMonth(),
		day: date.getUTCDate(),
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0,
	};
}

/** `DateUtils.getDate(y, m, d)`: the local midnight of a calendar day, which a
 * zone that skips midnight resolves to the first instant after its gap. */
export function localMidnight(calendarDays: number): number {
	return javaWallInstant(calendarFields(calendarDays));
}

/** The local calendar day an instant falls on, as days since 1970-01-01.
 * Fields copy via `setUTCFullYear`, never `Date.UTC`, whose two-digit-year
 * remapping would move a year 0001-0099 date nineteen centuries. */
export function localCalendarDays(instantMs: number): number {
	const local = new Date(instantMs);
	const midnight = new Date(0);
	midnight.setUTCFullYear(
		local.getFullYear(),
		local.getMonth(),
		local.getDate(),
	);
	return Math.round(midnight.getTime() / DAY);
}

/** `DateUtils.EPOCH_TIME` (and `EPOCH_DATE`): the local midnight of
 * 1970-01-01. */
function coreEpochTime(): number {
	return localMidnight(0);
}

/** `DateUtils.daysSinceEpoch` of a calendar day: `(roundDate(d) - EPOCH_TIME
 * + DAY / 2)` floor-divided by a fixed day (`MathUtils.divLongNotSuck`). */
export function coreDaysSinceEpoch(calendarDays: number): number {
	return Math.floor(
		(localMidnight(calendarDays) - coreEpochTime() + DAY / 2) / DAY,
	);
}

/** The calendar day of `DateUtils.dateAdd(getDate(1970, 1, 1), n)`, which is
 * `roundDate(EPOCH + n fixed days + half a day)`; `FunctionUtils.toDate`
 * sends a number through it. */
export function coreDateAdd(days: number): number {
	return localCalendarDays(coreEpochTime() + DAY * days + DAY / 2);
}

/** `DateUtils.fractionalDaysSinceEpoch`: the instant's distance from
 * `EPOCH_DATE` corrected by the change in `Date.getTimezoneOffset` (the
 * zone's, never a provider's) between the two, so it follows the wall clock. */
export function coreFractionalDays(instantMs: number): number {
	const epoch = coreEpochTime();
	const drift =
		(new Date(instantMs).getTimezoneOffset() -
			new Date(epoch).getTimezoneOffset()) *
		60_000;
	return (instantMs - epoch - drift) / DAY;
}
