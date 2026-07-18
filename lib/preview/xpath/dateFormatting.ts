// lib/preview/xpath/dateFormatting.ts
//
// Client-side implementation of JavaRosa's `DateUtils.format` pattern
// language. The XPath evaluator and the case-list Preview both call this
// helper so authored date styles have one Preview meaning. Unknown/unsupported
// escapes are reported explicitly; callers choose an honest, context-specific
// fallback instead of silently approximating the saved format.

import {
	COMMCARE_DAY_NAMES_LONG,
	COMMCARE_DAY_NAMES_SHORT,
	COMMCARE_MONTH_NAMES_LONG,
	COMMCARE_MONTH_NAMES_SHORT,
	type CommCareDateFormatToken,
	parseCommCareDatePattern,
} from "@/lib/domain/commCareDatePattern";
import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import type { XPathDate } from "./types";

interface DateFields {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly milliseconds: number;
	readonly dayOfWeek: number;
	readonly timezoneOffsetMinutes: number;
}

export type CommCareDateFormatResult =
	| { readonly kind: "formatted"; readonly text: string }
	| { readonly kind: "unsupported-pattern" };

/**
 * Format a parsed XPath date using the same supported escapes as JavaRosa's
 * `DateUtils.format`. Nova currently emits one English locale, so month/day
 * names intentionally match JavaRosa's default English calendar strings.
 */
export function formatCommCareDate(
	value: XPathDate,
	authoredPattern: string,
): CommCareDateFormatResult {
	const pattern = resolveCommCareDatePattern(authoredPattern);
	const parsed = parseCommCareDatePattern(pattern);
	if (parsed.kind === "unsupported-pattern") {
		return { kind: "unsupported-pattern" };
	}
	const fields = dateFields(value);
	let text = "";

	for (const segment of parsed.segments) {
		if (segment.kind === "literal") {
			text += segment.text;
			continue;
		}
		text += tokenValue(segment.token, fields);
	}

	return { kind: "formatted", text };
}

function dateFields(value: XPathDate): DateFields {
	const instant = value.toJSDate();
	if (value.time !== null) {
		return {
			year: instant.getFullYear(),
			month: instant.getMonth() + 1,
			day: instant.getDate(),
			hour: instant.getHours(),
			minute: instant.getMinutes(),
			second: instant.getSeconds(),
			milliseconds: instant.getMilliseconds(),
			dayOfWeek: instant.getDay(),
			timezoneOffsetMinutes: -instant.getTimezoneOffset(),
		};
	}

	// Date-only values are calendar dates, not UTC instants. `XPathDate` stores
	// their day count at UTC midnight; extract those calendar components and
	// create a local midnight only for weekday/offset lookup. This prevents a
	// negative-offset browser from moving `2026-07-14` back to July 13.
	const year = instant.getUTCFullYear();
	const monthIndex = instant.getUTCMonth();
	const day = instant.getUTCDate();
	const localMidnight = new Date(year, monthIndex, day);
	return {
		year,
		month: monthIndex + 1,
		day,
		hour: 0,
		minute: 0,
		second: 0,
		milliseconds: 0,
		dayOfWeek: localMidnight.getDay(),
		timezoneOffsetMinutes: -localMidnight.getTimezoneOffset(),
	};
}

function tokenValue(
	token: CommCareDateFormatToken,
	fields: DateFields,
): string {
	switch (token) {
		case "%":
			return "%";
		case "Y":
			return pad(fields.year, 4);
		case "y":
			return pad(fields.year, 4).slice(-2);
		case "m":
			return pad(fields.month, 2);
		case "n":
			return String(fields.month);
		case "B":
			return COMMCARE_MONTH_NAMES_LONG[fields.month - 1];
		case "b":
			return COMMCARE_MONTH_NAMES_SHORT[fields.month - 1];
		case "d":
			return pad(fields.day, 2);
		case "e":
			return String(fields.day);
		case "H":
			return pad(fields.hour, 2);
		case "h":
			return String(fields.hour);
		case "M":
			return pad(fields.minute, 2);
		case "S":
			return pad(fields.second, 2);
		case "3":
			return pad(fields.milliseconds, 3);
		case "A":
			return COMMCARE_DAY_NAMES_LONG[fields.dayOfWeek];
		case "a":
			return COMMCARE_DAY_NAMES_SHORT[fields.dayOfWeek];
		case "w":
			return String(fields.dayOfWeek);
		case "Z":
			return formatTimezoneOffset(fields.timezoneOffsetMinutes);
	}
}

function pad(value: number, length: number): string {
	return String(value).padStart(length, "0");
}

function formatTimezoneOffset(offsetMinutes: number): string {
	if (offsetMinutes === 0) return "Z";
	const sign = offsetMinutes > 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	const hours = pad(Math.trunc(absolute / 60), 2);
	const minutes = absolute % 60;
	return minutes === 0
		? `${sign}${hours}`
		: `${sign}${hours}:${pad(minutes, 2)}`;
}
