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
// The zone's offset is Java's (`lib/domain/javaZoneOffset.ts`): the IANA
// history from 1900-01-01T00:00Z on, and the zone's current standard offset
// before it, where `java.util.TimeZone` keeps no history. JavaScript's own
// local getters follow the IANA history further back (local mean time), so
// every local field here is read off the instant shifted by Java's offset,
// never through `Date`'s local getters.
//
// Core does every step in `long` milliseconds, so any `int` day number has a
// date. JavaScript's `Date` holds only ±8.64e15 ms (about ±273,790 years), so
// the day counts are integer arithmetic on days. Before 1900 the offset is
// constant, so it holds for the far past exactly; beyond `Date`'s future
// range it is the offset at the edge, the zone's final rule, as both the JDK
// and ICU extend it.
//
// Every function reads the realm's zone at the call: a browser page keeps one
// zone, and a test that assigns `process.env.TZ` sees the new one.

import {
	JAVA_ZONE_HISTORY_START_MS,
	javaRawOffsetMs,
	javaZoneOffsetMs,
	standardOffsetInstant,
} from "@/lib/domain/javaZoneOffset";

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
 * The realm zone's IANA offset at an instant in milliseconds, seconds
 * included (a local mean time such as Kolkata's +5:21:10 keeps them). An
 * instant beyond `Date`'s range takes the offset at the nearest edge.
 */
function ianaOffsetMs(instantMs: number): number {
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

/** The offset `java.util.TimeZone` gives the realm's zone at an instant: the
 * IANA offset from 1900 on, the zone's standard offset before it. */
function offsetMsAt(instantMs: number): number {
	return javaZoneOffsetMs(instantMs, ianaOffsetMs);
}

/**
 * `TimeZone.getOffset(era, year, month, day, dayOfWeek, 0)` of a calendar day:
 * the offset `DateUtils.formatTimeISO8601` stamps on a date and time.
 * OpenJDK's `ZoneInfo.getOffset` never resolves the day's wall clock: it
 * reads the day's midnight as if UTC, subtracts the zone's raw offset, and
 * answers the offset at that instant. Where a day's wall clocks repeat, that
 * is the earlier reading when the raw offset is the earlier one (Kiritimati
 * on 1900-01-01 stamps +14:00, though its midnight there reads -10:29:20 as
 * `Calendar` resolves it), and near a transition it can be the offset of
 * neither the day's midnight nor its instants.
 */
export function javaOffsetMsOnDay(calendarDays: number): number {
	return offsetMsAt(calendarDays * DAY - javaRawOffsetMs(ianaOffsetMs));
}

/** The instant whose IANA zone name is the one Java gives an instant: the
 * instant itself from 1900 on, and before it an instant in the zone's
 * standard time, since Java reads every earlier instant at its standard
 * offset. */
export function javaZoneNameInstant(instantMs: number): number {
	return instantMs < JAVA_ZONE_HISTORY_START_MS
		? standardOffsetInstant(ianaOffsetMs)
		: instantMs;
}

/** Milliseconds since 1970-01-01 of an instant's wall clock in the realm's
 * zone, read as if UTC: the instant plus Java's offset there. */
function wallMs(instantMs: number): number {
	return instantMs + offsetMsAt(instantMs);
}

/** The wall clock of an instant in the realm's zone, as Java reads it. */
export function javaLocalClock(
	instantMs: number,
): Pick<WallClock, "hour" | "minute" | "second" | "millisecond"> {
	const wall = wallMs(instantMs);
	const msOfDay = wall - floorDiv(wall, DAY) * DAY;
	return {
		hour: Math.floor(msOfDay / 3_600_000),
		minute: Math.floor(msOfDay / 60_000) % 60,
		second: Math.floor(msOfDay / 1000) % 60,
		millisecond: msOfDay % 1000,
	};
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
 * The candidate instants each nearby offset gives are tested here and the
 * latest one kept; when none reads back (a gap), the wall clock takes the
 * smaller offset, the one before the gap. Java's 1900 cutoff is such a
 * transition too: Kiritimati's +14:00 gives way to -10:29:20 there, so a
 * day of wall clocks repeats and the later reading wins. Authoring stamps a
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
	const offsets = [wallUtc - DAY, wallUtc, wallUtc + DAY].map(offsetMsAt);
	let latest: number | null = null;
	for (const offset of offsets) {
		const candidate = wallUtc - offset;
		if (wallMs(candidate) !== wallUtc) continue;
		if (latest === null || candidate > latest) latest = candidate;
	}
	return latest ?? wallUtc - Math.min(...offsets);
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

/** The local calendar day an instant falls on, as days since 1970-01-01:
 * its wall clock under Java's offset, floored to a day. An instant outside
 * `Date`'s range has none (NaN). */
export function localCalendarDays(instantMs: number): number {
	if (!(Math.abs(instantMs) <= DATE_LIMIT_MS)) return Number.NaN;
	return floorDiv(wallMs(instantMs), DAY);
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
	return {
		...date,
		...javaLocalClock(instant),
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

/**
 * Which midnight of 1970-01-01 a day number counts from. Core's
 * `DateUtils.EPOCH_TIME` (and `EPOCH_DATE`) is a static computed when the
 * class loads, in the JVM's default zone: the device's zone on Android
 * (`"device-zone"`), and `Etc/UTC` in Formplayer, whose JVM runs in UTC
 * (manifest `expressions-and-data/int`) before it sets the browser's zone per
 * request (`"utc"`). The epoch travels with each evaluation
 * (`EvalContext.dayNumberEpoch`), never in module state, so an evaluation
 * that awaits cannot read an epoch another one left behind.
 */
export type DayNumberEpoch = "utc" | "device-zone";

/** `DateUtils.EPOCH_TIME` under an epoch: UTC midnight, or the local midnight
 * of 1970-01-01. */
function coreEpochTime(epoch: DayNumberEpoch): number {
	return epoch === "utc" ? 0 : localMidnight(0);
}

/** `DateUtils.daysSinceEpoch` of a calendar day: `(roundDate(d) - EPOCH_TIME
 * + DAY / 2)` floor-divided by a fixed day (`MathUtils.divLongNotSuck`),
 * computed on the rounded day and the two small shifts so no instant leaves
 * the range doubles hold exactly. Null where `roundDate` gives null, which
 * makes Core's `roundDate(date).getTime()` throw a `NullPointerException`. */
export function coreDaysSinceEpoch(
	calendarDays: number,
	epoch: DayNumberEpoch,
): number | null {
	const rounded = coreRoundDay(calendarDays);
	if (rounded === null) return null;
	return (
		rounded +
		Math.floor(
			(localMidnightShift(rounded) - coreEpochTime(epoch) + DAY / 2) / DAY,
		)
	);
}

/** The calendar day of `DateUtils.dateAdd(getDate(1970, 1, 1), n)`, which is
 * `roundDate(EPOCH + n fixed days + half a day)`; `FunctionUtils.toDate`
 * sends a number through it. The local day of that instant is `n` plus the
 * whole days its offset and the epoch's carry it across, and `roundDate`
 * then folds or refuses it (`coreRoundDay`). Null where Core's `dateAdd`
 * returns null. */
export function coreDateAdd(days: number): number | null {
	/* Formplayer's `date(n)` calls `getDate(1970, 1, 1)` per call
	 * (`FunctionUtils.java`), after the browser's zone is set, so this stays
	 * on the local midnight on both platforms and takes no epoch. */
	const epoch = coreEpochTime("device-zone");
	const offset = offsetMsAt(epoch + days * DAY + DAY / 2);
	return coreRoundDay(days + Math.floor((epoch + DAY / 2 + offset) / DAY));
}

/** `java.util.Date.getTimezoneOffset`: minutes WEST of UTC, the zone's
 * (never a provider's) offset in milliseconds negated and divided as an
 * `int`, so a local mean time's seconds truncate toward zero. */
function javaTimezoneOffsetMinutes(instantMs: number): number {
	return Math.trunc(-offsetMsAt(instantMs) / 60_000);
}

/** `DateUtils.fractionalDaysSinceEpoch`: the instant's distance from
 * `EPOCH_DATE` corrected by the change in `Date.getTimezoneOffset` between
 * the two, so it follows the wall clock. Under `"utc"` both offsets are the
 * JVM's UTC offset, `0` at every instant, so it is the instant in days. */
export function coreFractionalDays(
	instantMs: number,
	epoch: DayNumberEpoch,
): number {
	if (epoch === "utc") return instantMs / DAY;
	const start = coreEpochTime(epoch);
	const drift =
		(javaTimezoneOffsetMinutes(instantMs) - javaTimezoneOffsetMinutes(start)) *
		60_000;
	return (instantMs - start - drift) / DAY;
}
