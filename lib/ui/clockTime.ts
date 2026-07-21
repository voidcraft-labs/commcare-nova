// Clock-time text → canonical 24-hour value — the pure parser behind
// `components/shadcn/time-field.tsx`. People type times in the
// locale's own clock ("2:30 PM"); the wire and the engines store the
// 24-hour canonical form. Kept React-free so pure state models (the
// data-review draft normalization) unit-test against it directly.

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
