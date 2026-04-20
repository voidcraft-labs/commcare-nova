/**
 * XPath date value — a first-class type in CommCare's XPath variant.
 *
 * Stores the date as integer days since the Unix epoch (1970-01-01),
 * matching CommCare core's `DateUtils.daysSinceEpoch()`. When used in
 * arithmetic, the date coerces to this integer — so `today() + 1`
 * naturally produces tomorrow's day-number. Wrapping the result in
 * `date()` converts it back to an ISO string.
 *
 * The optional `time` field preserves HMS for `now()` so that
 * `xpathToString` can emit a full ISO-8601 timestamp, while numeric
 * coercion still truncates to whole days (matching CommCare behavior).
 */
export class XPathDate {
	/** Days since 1970-01-01 (always an integer). */
	readonly days: number;
	/** Original JS Date — retained only for time-of-day in string output. */
	readonly time: Date | null;

	private constructor(days: number, time: Date | null) {
		this.days = days;
		this.time = time;
	}

	/** Create a date-only value (midnight, no time component). */
	static fromDays(days: number): XPathDate {
		return new XPathDate(Math.floor(days), null);
	}

	/** Create a date-only value from a JS Date, stripping the time component. */
	static fromJSDateOnly(d: Date): XPathDate {
		return new XPathDate(daysSinceEpoch(d), null);
	}

	/** Create a date from a JS Date, preserving time-of-day for string output. */
	static fromJSDate(d: Date): XPathDate {
		return new XPathDate(daysSinceEpoch(d), d);
	}

	/** Create a date by parsing an ISO-8601 date string (YYYY-MM-DD). */
	static parse(s: string): XPathDate | null {
		const trimmed = s.trim();
		/* Full ISO datetime — preserve time component */
		if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
			const d = new Date(trimmed);
			if (Number.isNaN(d.getTime())) return null;
			return XPathDate.fromJSDate(d);
		}
		/* Date-only — strict YYYY-MM-DD to avoid Date.parse quirks */
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
		if (!m) return null;
		const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
		if (Number.isNaN(d.getTime())) return null;
		return XPathDate.fromDays(daysSinceEpoch(d));
	}

	/** Convert this date back to a JS Date (midnight UTC for date-only). */
	toJSDate(): Date {
		if (this.time) return this.time;
		return new Date(this.days * 86_400_000);
	}

	/** ISO-8601 date string (YYYY-MM-DD), or full timestamp if time is present. */
	toISOString(): string {
		if (this.time) return this.time.toISOString();
		const d = new Date(this.days * 86_400_000);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, "0");
		const day = String(d.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	}
}

/** Whether a value is an XPathDate instance. */
export function isXPathDate(v: unknown): v is XPathDate {
	return v instanceof XPathDate;
}

/** XPath value types — primitives plus first-class dates. */
export type XPathValue = string | number | boolean | XPathDate;

/** Context for evaluating XPath expressions within a form. */
export interface EvalContext {
	/** Resolve an absolute path (/data/question_id) to its current value. */
	getValue(path: string): string | undefined;
	/** Resolve a hashtag ref (#case/prop, #user/prop, #form/question_id) to a value. */
	resolveHashtag(ref: string): string;
	/** Current field path (for '.') */
	contextPath: string;
	/** Current repeat position (for position()) — 1-based */
	position: number;
	/** Current repeat size (for last()) */
	size: number;
}

// ── Internal helpers ────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Integer days since Unix epoch for a JS Date, matching CommCare core's
 * `DateUtils.daysSinceEpoch()` — rounds to midnight then divides.
 */
function daysSinceEpoch(d: Date): number {
	/* Round to midnight UTC to avoid DST / timezone fractional-day drift. */
	const utcMidnight = Date.UTC(
		d.getUTCFullYear(),
		d.getUTCMonth(),
		d.getUTCDate(),
	);
	return Math.round(utcMidnight / MS_PER_DAY);
}
