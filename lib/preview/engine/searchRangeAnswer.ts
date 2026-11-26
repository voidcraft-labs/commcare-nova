// Core's DateRangeUtils, called once per starting value before the screen opens.
import type { SearchInputDef, Uuid } from "@/lib/domain";
import { javaZoneOffsetMs } from "@/lib/domain/javaZoneOffset";
import { ianaZoneOffsetMs } from "@/lib/domain/temporalValues";
import {
	type DayNumberEpoch,
	javaCalendarDate,
	javaCalendarDays,
	javaRangeDefaultDay,
} from "../xpath/coreDays";
import { isValidCalendarDate } from "./dateRangeInputValidation";

type RangeAnswer =
	| { readonly kind: "pair"; readonly from: string; readonly to: string }
	| { readonly kind: "unparsed"; readonly text: string };

const DAY_MS = 86_400_000;

/** SimpleDateFormat("yyyy-MM-dd", Locale.US) reads a numeric prefix in
 * each field, allows overflow and leaves trailing text unread. The pinned
 * Core formatter prints the resulting UTC midnight in the device's zone. */
function formatBound(
	text: string,
	epoch: DayNumberEpoch,
	zone?: string,
): string | undefined {
	const parts = /^\s*(-?\d+)-\s*(-?\d+)-\s*(-?\d+)/.exec(text);
	if (parts === null) return undefined;
	const year = Number(parts[1]);
	const month = Number(parts[2]) - 1;
	const days = javaCalendarDays(
		year + Math.floor(month / 12),
		(((month % 12) + 12) % 12) + 1,
		Number(parts[3]),
	);
	if (!Number.isSafeInteger(days) || Math.abs(days * DAY_MS) > 8.64e15)
		return undefined;
	let printedDay = days;
	if (epoch === "device-zone") {
		printedDay = javaRangeDefaultDay(
			days,
			zone === undefined
				? undefined
				: (instant) =>
						javaZoneOffsetMs(instant, (ms) => ianaZoneOffsetMs(zone, ms)),
		);
	}
	if (!Number.isFinite(printedDay) || Math.abs(printedDay * DAY_MS) > 8.64e15)
		return undefined;
	const date = javaCalendarDate(printedDay);
	return [
		String(date.year).padStart(4, "0"),
		String(date.month).padStart(2, "0"),
		String(date.day).padStart(2, "0"),
	].join("-");
}

/** The displayed value of the Android range prompt. It expands a pair's
 * wrapper even when the two pieces are not calendar dates. */
export function androidStartingRangeLabel(
	raw: string | undefined,
): string | undefined {
	if (!raw?.startsWith("__range__")) return raw;
	const pieces = raw.split("__");
	while (pieces.at(-1) === "") pieces.pop();
	return pieces.length === 4 ? `${pieces[2]} to ${pieces[3]}` : raw;
}

/** The Android Material range picker supplies each selected day at UTC
 * midnight. Its callback prints that instant in the worker's zone. */
export function androidSelectedRangeDay(
	selected: string,
	zone?: string,
): string {
	if (!isValidCalendarDate(selected)) return selected;
	const midnight = Date.parse(`${selected}T00:00:00Z`);
	const offset = javaZoneOffsetMs(
		midnight,
		zone
			? (instant) => ianaZoneOffsetMs(zone, instant)
			: (instant) => -new Date(instant).getTimezoneOffset() * 60_000,
	);
	const date = javaCalendarDate(Math.floor((midnight + offset) / DAY_MS));
	return [
		String(date.year).padStart(4, "0"),
		String(date.month).padStart(2, "0"),
		String(date.day).padStart(2, "0"),
	].join("-");
}

/** A parse failure keeps the expression's exact evaluated text. An already
 * encoded pair is one such value and remains usable without another zone shift. */
export function startingSearchRange(
	value: string,
	epoch: DayNumberEpoch,
	zone?: string,
): RangeAnswer {
	if (value === "") return { kind: "unparsed", text: "" };
	const parts = value.split(" to ");
	while (parts.at(-1) === "") parts.pop();
	let text = value;
	if (parts.length === 2) {
		const from = formatBound(parts[0], epoch, zone);
		const to = formatBound(parts[1], epoch, zone);
		if (from !== undefined && to !== undefined)
			text = `__range__${from}__${to}`;
	}
	const encoded = /^__range__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})$/.exec(
		text,
	);
	if (
		encoded &&
		isValidCalendarDate(encoded[1]) &&
		isValidCalendarDate(encoded[2])
	)
		return { kind: "pair", from: encoded[1], to: encoded[2] };
	return { kind: "unparsed", text };
}

/** The original Core answer before the client draws any fields. */
export function setStartingRangeValues(
	values: Map<string, string>,
	name: string,
	value: string,
	epoch: DayNumberEpoch,
	zone?: string,
): void {
	const range = startingSearchRange(value, epoch, zone);
	if (range.kind === "unparsed") {
		values.set(`${name}:starting`, range.text);
		return;
	}
	values.set(`${name}:from`, range.from);
	values.set(`${name}:to`, range.to);
	if (range.from > range.to) values.set(`${name}:starting`, value);
}

/** HQ's Web Apps query view decodes defaults with its M/D/YYYY date input
 * before encoding the visible fields for an explicit Search. An automatic
 * Search can execute without constructing this view and keeps Core’s answer. */
function browserCalendarDate(instant: Date, zone?: string): string {
	const date =
		zone === undefined
			? instant
			: new Date(instant.getTime() + ianaZoneOffsetMs(zone, instant.getTime()));
	const year = zone === undefined ? date.getFullYear() : date.getUTCFullYear();
	const month = 1 + (zone === undefined ? date.getMonth() : date.getUTCMonth());
	const day = zone === undefined ? date.getDate() : date.getUTCDate();
	return `${year < 0 ? "-" : ""}${String(Math.abs(year)).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function webCalendarDate(text: string, zone?: string): string | undefined {
	if (isValidCalendarDate(text)) return text;
	// HQ uses Moment's strict YYYY-MM-DDTHH:mm:ssZ. Its offset token
	// accepts Z or signed hours with optional minutes. Its only hour 24
	// is midnight at the start of the next day.
	const stamp =
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[zZ]|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(
			text,
		);
	if (stamp) {
		const [, calendar, hour, minute, second, sign, offsetHour, offsetMinute] =
			stamp;
		if (
			!isValidCalendarDate(calendar) ||
			+hour > 24 ||
			+minute > 59 ||
			+second > 59 ||
			(+hour === 24 && (+minute !== 0 || +second !== 0))
		)
			return undefined;
		const offset =
			(sign === "-" ? -1 : 1) *
			(Number(offsetHour ?? 0) * 60 + Number(offsetMinute ?? 0));
		const instant =
			Date.parse(calendar + "T00:00:00Z") +
			((+hour * 60 + +minute - offset) * 60 + +second) * 1000;
		return browserCalendarDate(new Date(instant), zone);
	}
	const short = /^(\d{1,2})\D(\d{1,2})\D(\d{2})$/.exec(text);
	const us = short ?? /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/.exec(text);
	if (!us) return undefined;
	const month = us[1],
		date = short ? us[2] : us[3];
	let year = Number(short ? us[3] : us[4]);
	if (short) {
		const current = Number(browserCalendarDate(new Date(), zone).slice(0, 4));
		year += Math.floor(current / 100) * 100;
		if (year > current + 10) year -= 100;
	}
	const day = `${String(year).padStart(4, "0")}-${month.padStart(2, "0")}-${date.padStart(2, "0")}`;
	return isValidCalendarDate(day) ? day : undefined;
}

export function webSearchRangeDraft(
	inputs: readonly SearchInputDef[],
	starting: ReadonlyMap<string, string>,
	zone?: string,
): {
	draft: ReadonlyMap<string, string>;
	labels?: ReadonlyMap<string, string>;
	unavailable?: { inputUuid: Uuid; input: string };
} {
	let draft: Map<string, string> | undefined;
	const labels = new Map<string, string>();
	for (const input of inputs) {
		if (input.kind === "hidden" || input.type !== "date-range") continue;
		const text = starting.get(`${input.name}:starting`);
		if (text === undefined || starting.has(`${input.name}:from`)) continue;
		draft ??= new Map(starting);
		draft.delete(`${input.name}:starting`);
		const values = text.split("#,#").filter(Boolean);
		if (values.length !== 1) {
			draft.delete(input.name + ":opening");
			continue;
		}
		const pieces = values[0]
			.replace("__range__", "")
			.replace(" to ", "__")
			.split("__");
		const dates: string[] = [];
		for (const piece of pieces) {
			const date = webCalendarDate(piece, zone);
			if (date === undefined)
				return {
					draft,
					unavailable: {
						inputUuid: input.uuid,
						input: input.label || input.name,
					},
				};
			dates.push(date);
		}
		if (dates.length !== 2 || dates[0] > dates[1]) {
			// The Web Apps text field displays every readable date. Submitting
			// without editing encodes them all, even when HQ rejects that criterion.
			draft.set(`${input.name}:starting`, `__range__${dates.join("__")}`);
			const display = dates.map((day) => {
				const year = day.slice(0, -6);
				const month = day.slice(-5, -3);
				const date = day.slice(-2);
				return `${Number(month)}/${Number(date)}/${year}`;
			});
			labels.set(input.name, display.join(" to "));
		} else {
			draft.delete(input.name + ":opening");
			draft.set(`${input.name}:from`, dates[0]);
			draft.set(`${input.name}:to`, dates[1]);
		}
	}
	return { draft: draft ?? starting, labels };
}
