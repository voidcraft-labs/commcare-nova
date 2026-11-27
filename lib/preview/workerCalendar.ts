import type { DateField } from "@/lib/domain";
import {
	instantDatetimeValue,
	isReadableTemporalValue,
	storageDatetimeValue,
} from "@/lib/domain/temporalValues";
import { NEPALI_FIRST_YEAR, NEPALI_MONTH_LENGTHS } from "./nepaliMonthLengths";
import { XPathDate } from "./xpath/types";

export type WorkerCalendar = "ethiopian" | "nepali" | "gregorian";
/** The Gregorian editor can empty all three date parts. Its clear-button
 * variant also empties them in one action. The other Android pickers always
 * have a day (DateWidget and AbstractUniversalDateWidget.getAnswer). */
export function androidCalendarCanBeEmpty(
	calendar: DateField["calendar"],
): boolean {
	return calendar === "gregorian" || calendar === "gregorian-with-clear";
}
/** Android populates its pickers from the instant in the device zone and
 * reconstructs the answer from that local date, hour and minute. */
export function androidDatetimePickerValue(
	value: string,
	zone: string,
): string | undefined {
	if (value !== "" && !isReadableTemporalValue("datetime", value))
		return undefined;
	const instant =
		value === ""
			? Date.now()
			: XPathDate.parseExactInstant(
					storageDatetimeValue(value, zone),
				)?.instant();
	if (instant === undefined) return undefined;
	const shown = instantDatetimeValue(instant, zone);
	return storageDatetimeValue(shown.slice(0, 16), zone);
}

export interface CalendarDay {
	year: number;
	month: number;
	day: number;
}
const DAY_MS = 86_400_000;
const ethiopian = new Intl.DateTimeFormat("en-US-u-ca-ethiopic-nu-latn", {
	day: "numeric",
	month: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
const nepaliMonths = [
	"Baishakh",
	"Jestha",
	"Ashadh",
	"Shrawan",
	"Bhadra",
	"Ashwin",
	"Kartik",
	"Mangsir",
	"Poush",
	"Magh",
	"Falgun",
	"Chaitra",
];
const yearStarts = [0];
for (const months of NEPALI_MONTH_LENGTHS)
	yearStarts.push(
		yearStarts[yearStarts.length - 1] +
			months.reduce((sum, days) => sum + days, 0),
	);
// CalendarUtils.countDaysFromMinDay(2026,9,17) anchors 1970-01-01 CE.
const epochYear = 2026 - NEPALI_FIRST_YEAR;
const epoch =
	yearStarts[epochYear] +
	NEPALI_MONTH_LENGTHS[epochYear].slice(0, 8).reduce((sum, n) => sum + n, 0) +
	16;

export function calendarDay(
	day: number,
	calendar: WorkerCalendar,
): CalendarDay | undefined {
	const date = new Date(day * DAY_MS);
	if (!Number.isFinite(date.getTime())) return undefined;
	if (calendar === "gregorian") {
		const year = date.getUTCFullYear();
		if (year < 1900 || year > 2100) return undefined;
		return {
			year,
			month: date.getUTCMonth() + 1,
			day: date.getUTCDate(),
		};
	}
	if (calendar === "ethiopian") {
		const values = ethiopian.formatToParts(date);
		const part = (name: "year" | "month" | "day") =>
			Number(values.find((p) => p.type === name)?.value);
		return { year: part("year"), month: part("month"), day: part("day") };
	}
	const offset = day + epoch;
	if (offset < 0 || offset >= yearStarts[yearStarts.length - 1])
		return undefined;
	const i = yearStarts.findIndex((start) => start > offset) - 1;
	let within = offset - yearStarts[i];
	const months = NEPALI_MONTH_LENGTHS[i];
	for (const [m, length] of months.entries()) {
		if (within < length)
			return { year: NEPALI_FIRST_YEAR + i, month: m + 1, day: within + 1 };
		within -= length;
	}
	return undefined;
}

/** Walk the same civil days the form stores. No selection passes through
 * local midnight or a daylight-saving offset. */
export function calendarMonth(day: number, calendar: WorkerCalendar) {
	const current = calendarDay(day, calendar);
	if (!current) return undefined;
	const start = day - current.day + 1;
	const dates: number[] = [];
	for (let d = start; d < start + 32; d++) {
		const local = calendarDay(d, calendar);
		if (!local || local.month !== current.month || local.year !== current.year)
			break;
		dates.push(d);
	}
	return {
		start,
		dates,
		previous: calendarDay(start - 1, calendar) ? start - 1 : undefined,
		next: calendarDay(start + dates.length, calendar)
			? start + dates.length
			: undefined,
	};
}

export function calendarText(
	day: number,
	calendar: WorkerCalendar,
	locale: string,
	includeDay: boolean,
) {
	const local = calendarDay(day, calendar);
	if (!local) return undefined;
	if (calendar === "nepali")
		return [
			includeDay ? local.day : undefined,
			nepaliMonths[local.month - 1],
			local.year,
		]
			.filter((n) => n !== undefined)
			.join(" ");
	return new Intl.DateTimeFormat(locale, {
		calendar: calendar === "ethiopian" ? "ethiopic" : "gregory",
		month: "long",
		year: "numeric",
		...(includeDay && { day: "numeric" }),
		timeZone: "UTC",
	}).format(new Date(day * DAY_MS));
}

export function isoOfCalendarDay(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
export function calendarDayOfIso(iso: string): number | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
	const day = Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
	return Number.isFinite(day) && isoOfCalendarDay(day) === iso
		? day
		: undefined;
}
export function localToday(): number {
	const now = new Date();
	return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
}
