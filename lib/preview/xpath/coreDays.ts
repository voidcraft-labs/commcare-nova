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
// Core reads and writes calendar fields through `Calendar.getInstance()`, a
// `java.util.GregorianCalendar`: Julian before 1582-10-15, Gregorian from it,
// with `YEAR` counted in its era. Days here are calendar-neutral (days since
// 1970-01-01, one per solar day); only the fields a day is read as or written
// from follow Java's calendar (`javaCalendarDate`, `javaCalendarDays`).
//
// Core does every step in `long` milliseconds, so any `int` day number has a
// date. JavaScript's `Date` holds only ±8.64e15 ms (about ±273,790 years), so
// the day counts are integer arithmetic on days, and a zone's offset beyond
// that range is the offset at its nearest edge: the zone's local mean time in
// the past and its final rule in the future, as both the JDK and ICU extend
// them.
//
// Every function reads the realm's zone at the call: a browser page keeps one
// zone, and a test that assigns `process.env.TZ` sees the new one.

const DAY = 86_400_000;

/** `GregorianCalendar`'s default cutover, 1582-10-15, as days since
 * 1970-01-01: every earlier day has Julian fields. */
const GREGORIAN_CUTOVER_DAY = -141_427;

/** The widest instant JavaScript's `Date` holds. */
const DATE_LIMIT_MS = 8.64e15;

/** The widest instant whose local fields `Date` still reads in every zone:
 * two days inside the limit, so no offset carries the wall clock past it. */
const LOCAL_LIMIT_MS = DATE_LIMIT_MS - 2 * DAY;

/** An instant moved into the range `Date` reads local fields in. */
const withinLocalLimit = (instantMs: number): number =>
	Math.max(-LOCAL_LIMIT_MS, Math.min(LOCAL_LIMIT_MS, instantMs));

/** A calendar date, its month one-based. */
export interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

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

/** The fields `DateUtils.getFields` reads off an instant in the device zone. */
export interface JavaLocalFields extends CalendarDate {
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
	/** Sunday is 0. */
	readonly dayOfWeek: number;
	/** The zone's offset at the instant, in whole and fractional minutes. */
	readonly offsetMinutes: number;
}

const floorDiv = (value: number, divisor: number): number =>
	Math.floor(value / divisor);

/** Days since 1970-01-01 of a proleptic Gregorian date (any integer year). */
function gregorianDays(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = floorDiv(y, 400);
	const yearOfEra = y - era * 400;
	const dayOfYear =
		floorDiv(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 +
		floorDiv(yearOfEra, 4) -
		floorDiv(yearOfEra, 100) +
		dayOfYear;
	return era * 146_097 + dayOfEra - 719_468;
}

/** The proleptic Gregorian date of a day since 1970-01-01. */
function gregorianDate(days: number): CalendarDate {
	const shifted = days + 719_468;
	const era = floorDiv(shifted, 146_097);
	const dayOfEra = shifted - era * 146_097;
	const yearOfEra = floorDiv(
		dayOfEra -
			floorDiv(dayOfEra, 1460) +
			floorDiv(dayOfEra, 36_524) -
			floorDiv(dayOfEra, 146_096),
		365,
	);
	const dayOfYear =
		dayOfEra -
		(365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
	return marchDate(yearOfEra + era * 400, dayOfYear);
}

/** Days since 1970-01-01 of a proleptic Julian date (any integer year). */
function julianDays(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = floorDiv(y, 4);
	const yearOfEra = y - era * 4;
	const dayOfYear =
		floorDiv(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1;
	return era * 1461 + yearOfEra * 365 + dayOfYear - 719_470;
}

/** The proleptic Julian date of a day since 1970-01-01. */
function julianDate(days: number): CalendarDate {
	const shifted = days + 719_470;
	const era = floorDiv(shifted, 1461);
	const dayOfEra = shifted - era * 1461;
	const yearOfEra = Math.min(floorDiv(dayOfEra, 365), 3);
	return marchDate(yearOfEra + era * 4, dayOfEra - 365 * yearOfEra);
}

/** A date from a March-based year and its day (0 is 1 March). */
function marchDate(marchYear: number, dayOfYear: number): CalendarDate {
	const marchMonth = floorDiv(5 * dayOfYear + 2, 153);
	const day = dayOfYear - floorDiv(153 * marchMonth + 2, 5) + 1;
	const month = marchMonth < 10 ? marchMonth + 3 : marchMonth - 9;
	return { year: month <= 2 ? marchYear + 1 : marchYear, month, day };
}

/**
 * The fields `GregorianCalendar` reads off a day (`Calendar.get(YEAR)`,
 * `MONTH`, `DAY_OF_MONTH`): Julian before the cutover, Gregorian from it.
 * `YEAR` is counted in its era, so 1 BC reads as year 1 and 2 BC as year 2;
 * Core reads `YEAR` alone.
 */
export function javaCalendarDate(days: number): CalendarDate {
	if (days >= GREGORIAN_CUTOVER_DAY) return gregorianDate(days);
	const julian = julianDate(days);
	return julian.year > 0 ? julian : { ...julian, year: 1 - julian.year };
}

/**
 * The day a lenient `GregorianCalendar` (era AD, as `Calendar.getInstance()`
 * starts) gives the fields `DateUtils.getDate` sets: Julian when they fall
 * before 1582-10-15, Gregorian from it. A date in the cutover's gap
 * (1582-10-05 to 10-14) is read as Julian, as `GregorianCalendar.computeTime`
 * reads it. Year 0 is 1 BC. Core validates fields first
 * (`DateFields.check`, proleptic Gregorian), and every such date is a Julian
 * date too.
 */
export function javaCalendarDays(
	year: number,
	month: number,
	day: number,
): number {
	const beforeCutover =
		year < 1582 ||
		(year === 1582 && (month < 10 || (month === 10 && day < 15)));
	return beforeCutover
		? julianDays(year, month, day)
		: gregorianDays(year, month, day);
}

/** `DateFields.check`'s calendar arm: month 1-12 and a day the proleptic
 * Gregorian month holds (`DateUtils.daysInMonth`, `isLeap`). */
export function isCoreCalendarDate(
	year: number,
	month: number,
	day: number,
): boolean {
	if (month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const length =
		month === 2
			? leap
				? 29
				: 28
			: month === 4 || month === 6 || month === 9 || month === 11
				? 30
				: 31;
	return day <= length;
}

/**
 * The zone's offset at an instant in milliseconds, seconds included (a local
 * mean time such as New York's -4:56:02 keeps them). An instant beyond
 * `Date`'s range takes the offset at the nearest edge.
 */
function offsetMsAt(instantMs: number): number {
	const clamped = withinLocalLimit(instantMs);
	const local = new Date(clamped);
	const wall = new Date(0);
	wall.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate());
	wall.setUTCHours(
		local.getHours(),
		local.getMinutes(),
		local.getSeconds(),
		local.getMilliseconds(),
	);
	return wall.getTime() - clamped;
}

/**
 * The instant `java.util.Calendar` gives a wall clock in this realm's zone
 * (`DateUtils.getDate(DateFields, String)` sets each field on a lenient
 * `GregorianCalendar`, so the date is read in Java's calendar,
 * `javaCalendarDays`). Java resolves a wall clock through
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
 *
 * A wall clock beyond `Date`'s range has no instant here (NaN).
 */
export function javaWallInstant(wall: WallClock): number {
	return wallInstantOnDay(
		javaCalendarDays(wall.year, wall.monthIndex + 1, wall.day),
		wall,
	);
}

function wallInstantOnDay(
	days: number,
	clock: Pick<WallClock, "hour" | "minute" | "second" | "millisecond">,
): number {
	const clockMs =
		((clock.hour * 60 + clock.minute) * 60 + clock.second) * 1000 +
		clock.millisecond;
	const wallUtc = days * DAY + clockMs;
	if (Math.abs(wallUtc) > LOCAL_LIMIT_MS - DAY) return Number.NaN;
	let latest: number | null = null;
	for (const probe of [wallUtc - DAY, wallUtc, wallUtc + DAY]) {
		const candidate = wallUtc - offsetMsAt(probe);
		if (localCalendarDays(candidate) !== days) continue;
		const local = new Date(candidate);
		if (
			local.getHours() !== clock.hour ||
			local.getMinutes() !== clock.minute ||
			local.getSeconds() !== clock.second ||
			local.getMilliseconds() !== clock.millisecond
		) {
			continue;
		}
		if (latest === null || candidate > latest) latest = candidate;
	}
	if (latest !== null) return latest;
	// `Date`'s setters take proleptic Gregorian fields.
	const date = gregorianDate(days);
	const forward = new Date(0);
	forward.setFullYear(date.year, date.month - 1, date.day);
	forward.setHours(clock.hour, clock.minute, clock.second, clock.millisecond);
	return forward.getTime();
}

const MIDNIGHT = { hour: 0, minute: 0, second: 0, millisecond: 0 } as const;

/** How far a day's local midnight instant lies from `days * DAY`: minus the
 * zone's offset there, or a gap's length less that when midnight is skipped.
 * Beyond `Date`'s range, minus the edge offset. */
function localMidnightShift(calendarDays: number): number {
	const instant = wallInstantOnDay(calendarDays, MIDNIGHT);
	return Number.isNaN(instant)
		? -offsetMsAt(calendarDays * DAY)
		: instant - calendarDays * DAY;
}

/** `DateUtils.getDate(y, m, d)`: the local midnight of a calendar day, which a
 * zone that skips midnight resolves to the first instant after its gap. Beyond
 * `Date`'s range the instant is approximate (a double past 2^53 ms). */
export function localMidnight(calendarDays: number): number {
	return calendarDays * DAY + localMidnightShift(calendarDays);
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

/**
 * `DateUtils.getFields` of a value: Java's calendar fields of its local day,
 * its local clock, and the zone's offset there. A date-only value (`instantMs`
 * null) is its local midnight. Beyond `Date`'s range only a date-only value
 * exists, read at 00:00 with the edge offset.
 */
export function javaLocalFields(
	calendarDays: number,
	instantMs: number | null,
): JavaLocalFields {
	const instant = instantMs ?? localMidnight(calendarDays);
	const date = javaCalendarDate(calendarDays);
	const dayOfWeek = (((calendarDays + 4) % 7) + 7) % 7;
	if (Math.abs(instant) > LOCAL_LIMIT_MS) {
		return {
			...date,
			...MIDNIGHT,
			dayOfWeek,
			offsetMinutes: offsetMsAt(instant) / 60_000,
		};
	}
	const local = new Date(instant);
	return {
		...date,
		hour: local.getHours(),
		minute: local.getMinutes(),
		second: local.getSeconds(),
		millisecond: local.getMilliseconds(),
		dayOfWeek,
		offsetMinutes: offsetMsAt(instant) / 60_000,
	};
}

/**
 * `DateUtils.roundDate` of a value on a calendar day, as a day:
 * `getDate(f.year, f.month, f.day)` over `getFields(d)`. Neither half is the
 * identity at the calendar's edges, and every `daysSinceEpoch`, `dateAdd`
 * and `FunctionUtils.toDate` of a Date runs through it:
 *
 * - `getFields` reads `Calendar.YEAR` without its era, and `getDate` sets it
 *   on a fresh calendar whose era is AD, so a day before AD 1 folds to the
 *   AD date with the same fields (1 BC June 15 becomes AD 1 June 15).
 * - `getDate` first runs `DateFields.check`, whose leap rule is proleptic
 *   Gregorian (`isCoreCalendarDate`), and returns null when it fails. The
 *   Julian calendar before 1582-10-15 has February 29 in years that rule
 *   calls common (100, 200, 300, 500, ...), so those days round to null.
 *
 * Returns null where Core's `roundDate` returns null.
 */
export function coreRoundDay(calendarDays: number): number | null {
	const { year, month, day } = javaCalendarDate(calendarDays);
	return isCoreCalendarDate(year, month, day)
		? javaCalendarDays(year, month, day)
		: null;
}

/** `DateUtils.EPOCH_TIME` (and `EPOCH_DATE`): the local midnight of
 * 1970-01-01. */
function coreEpochTime(): number {
	return localMidnight(0);
}

/** `DateUtils.daysSinceEpoch` of a calendar day: `(roundDate(d) - EPOCH_TIME
 * + DAY / 2)` floor-divided by a fixed day (`MathUtils.divLongNotSuck`),
 * computed on the rounded day and the two small shifts so no instant leaves
 * the range doubles hold exactly. Null where `roundDate` gives null, which
 * makes Core's `roundDate(date).getTime()` throw a `NullPointerException`. */
export function coreDaysSinceEpoch(calendarDays: number): number | null {
	const rounded = coreRoundDay(calendarDays);
	if (rounded === null) return null;
	return (
		rounded +
		Math.floor((localMidnightShift(rounded) - coreEpochTime() + DAY / 2) / DAY)
	);
}

/** The calendar day of `DateUtils.dateAdd(getDate(1970, 1, 1), n)`, which is
 * `roundDate(EPOCH + n fixed days + half a day)`; `FunctionUtils.toDate`
 * sends a number through it. The local day of that instant is `n` plus the
 * whole days its offset and the epoch's carry it across, and `roundDate`
 * then folds or refuses it (`coreRoundDay`). Null where Core's `dateAdd`
 * returns null. */
export function coreDateAdd(days: number): number | null {
	const epoch = coreEpochTime();
	const offset = offsetMsAt(epoch + days * DAY + DAY / 2);
	return coreRoundDay(days + Math.floor((epoch + DAY / 2 + offset) / DAY));
}

/** `DateUtils.fractionalDaysSinceEpoch`: the instant's distance from
 * `EPOCH_DATE` corrected by the change in `Date.getTimezoneOffset` (the
 * zone's, in whole minutes, never a provider's) between the two, so it
 * follows the wall clock. */
export function coreFractionalDays(instantMs: number): number {
	const epoch = coreEpochTime();
	const drift =
		(new Date(withinLocalLimit(instantMs)).getTimezoneOffset() -
			new Date(epoch).getTimezoneOffset()) *
		60_000;
	return (instantMs - epoch - drift) / DAY;
}
