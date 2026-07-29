// Clock-time text ⇄ canonical 24-hour value — the pure parse/format pair
// behind `components/shadcn/time-field.tsx`. People type times in the
// locale's own clock ("2:30 PM"); the wire and the engines store the
// 24-hour canonical form. Kept React-free so pure state models (the
// data-review draft normalization) unit-test against it directly.

import {
	isStorageTemporalValue,
	wireTimeOfDay,
} from "@/lib/domain/temporalValues";

/**
 * Parse a typed clock time the way a person writes one — "2:30 PM",
 * "9:05am", "14:30", "14:30:05" — into the padded 24-hour `HH:MM:SS`,
 * or `null` when the text isn't a real clock time. The 12-hour spelling
 * is the one the interface shows (locale clocks, not wire clocks); the
 * bare 24-hour form still parses for people who type it. Hand-typed
 * input — so the shape AND the ranges are checked rather than trusted.
 */
export function parseClockTime(text: string): string | null {
	const match =
		/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(
			text.trim(),
		);
	if (match === null) return null;
	let hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = match[3] === undefined ? 0 : Number(match[3]);
	if (minutes > 59 || seconds > 59) return null;
	const meridiem = match[4]?.toLowerCase();
	if (meridiem !== undefined) {
		if (hours < 1 || hours > 12) return null;
		if (meridiem === "p" && hours !== 12) hours += 12;
		if (meridiem === "a" && hours === 12) hours = 0;
	} else if (hours > 23) {
		return null;
	}
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The locale-clock spelling of a STORED time — "2:30 PM" for the
 * `14:30:00.000Z` a case property holds. The display half of the pair
 * `parseClockTime` opens, and its inverse: every string this returns
 * parses back to the same clock, which is what lets a field show a
 * friendly value and still commit the stored one after a focus and blur
 * that changed nothing.
 *
 * `null` means "show the raw value instead", and it covers two cases that
 * want exactly that:
 *
 *   - Text that is not a stored time at all — the half-typed "2:3" a
 *     person is still in the middle of. Reformatting mid-keystroke would
 *     rewrite "2:30" to "2:30 AM" under someone reaching for PM.
 *   - A stored time this spelling cannot carry back: seconds are shown
 *     only when they are non-zero, and a fractional second has nowhere to
 *     go at all, so an imported `14:30:00.500Z` stays verbatim rather than
 *     being displayed as a value that would commit back a half-second
 *     short.
 */
export function formatClockTime(value: string): string | null {
	if (!isStorageTemporalValue("time", value)) return null;
	const [hoursText, minutes, secondsAndMillis] =
		wireTimeOfDay(value).split(":");
	const [seconds, millis] = secondsAndMillis.split(".");
	if (millis !== "000") return null;
	const hours = Number(hoursText);
	const meridiem = hours < 12 ? "AM" : "PM";
	const clockHours = hours % 12 === 0 ? 12 : hours % 12;
	const withSeconds = seconds === "00" ? "" : `:${seconds}`;
	return `${clockHours}:${minutes}${withSeconds} ${meridiem}`;
}
