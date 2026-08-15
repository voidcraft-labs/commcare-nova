/**
 * XPath date value — a first-class type in CommCare's XPath variant.
 *
 * Stores the date as integer days since the Unix epoch (1970-01-01),
 * matching CommCare core's `DateUtils.daysSinceEpoch()`. When used in
 * arithmetic, the date coerces to this integer — so `today() + 1`
 * naturally produces tomorrow's day-number. Wrapping the result in
 * `date()` converts it back to an ISO string.
 *
 * The optional `time` field preserves HMS for `double(now())` and date
 * formatting. XPath string coercion still emits Core's local date only.
 */
export class XPathDate {
	/** Days since 1970-01-01 (always an integer). */
	readonly days: number;
	/** Original JS Date — retained for double() and date formatting. */
	readonly time: Date | null;

	private constructor(days: number, time: Date | null) {
		this.days = days;
		this.time = time;
	}

	/** Create a date-only value (midnight, no time component). */
	static fromDays(days: number): XPathDate {
		return new XPathDate(Math.trunc(days), null);
	}

	/** Create a date-only value from a JS Date, stripping the time component. */
	static fromJSDateOnly(d: Date): XPathDate {
		return new XPathDate(daysSinceEpoch(d), null);
	}

	/** Create a date from a JS Date, preserving time-of-day for date functions. */
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
		/* Date-only — explicit component parse to avoid Date.parse quirks.
		 * Components may be non-padded ("2024-5-1"): JavaRosa's parseDate
		 * splits on dash and Integer.parseInt's each piece
		 * (commcare-core DateUtils.java::parseDateFragment), so a
		 * non-padded literal is legal on-device and must parse here too. */
		const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
		if (!m) return null;
		const year = +m[1];
		const monthIndex = +m[2] - 1;
		const day = +m[3];
		// Construct via `setUTCFullYear`, never `Date.UTC(year, ...)` — the
		// latter remaps two-digit years to 1900-1999, which would both shift
		// the value and make the round-trip guard below reject every valid
		// year 0001-0099 date (JavaRosa's `DateFields.check()` accepts them;
		// it range-checks only month and day).
		const d = new Date(0);
		d.setUTCFullYear(year, monthIndex, day);
		if (Number.isNaN(d.getTime())) return null;
		// The setter normalizes invalid calendar input (February 31 → March
		// 3), while JavaRosa's `DateFields.check()` rejects it. Compare the
		// parsed components so Preview does not quietly display a different
		// date.
		if (
			d.getUTCFullYear() !== year ||
			d.getUTCMonth() !== monthIndex ||
			d.getUTCDate() !== day
		) {
			return null;
		}
		return XPathDate.fromDays(Math.round(d.getTime() / MS_PER_DAY));
	}

	/** Convert this date back to a JS Date (midnight UTC for date-only). */
	toJSDate(): Date {
		if (this.time) return this.time;
		return new Date(this.days * 86_400_000);
	}

	/** XPath string coercion for a Date is always the local YYYY-MM-DD date.
	 * Core's `FunctionUtils.toString(Date)` deliberately discards time. */
	toISOString(): string {
		const d = this.time ?? new Date(this.days * 86_400_000);
		const y = this.time ? d.getFullYear() : d.getUTCFullYear();
		const m = String((this.time ? d.getMonth() : d.getUTCMonth()) + 1).padStart(
			2,
			"0",
		);
		const day = String(this.time ? d.getDate() : d.getUTCDate()).padStart(
			2,
			"0",
		);
		return `${y}-${m}-${day}`;
	}
}

/** Whether a value is an XPathDate instance. */
export function isXPathDate(v: unknown): v is XPathDate {
	return v instanceof XPathDate;
}

/** XPath value types — primitives plus first-class dates. */
export type XPathValue = string | number | boolean | XPathDate;

/** Result from a deliberately context-scoped function implementation. The
 * ordinary Preview registry remains the complete user-authored function set;
 * generated carriers can opt into exact handlers for expressions Nova itself
 * emitted without advertising those handlers as general XPath support. */
export type XPathFunctionInvocation =
	| { readonly kind: "handled"; readonly value: XPathValue }
	| { readonly kind: "unsupported" };

/** Explicit result from a secondary-instance resolver. Missing values inside
 * a known instance are distinct from an unsupported namespace. */
export type InstanceResolution =
	| { readonly kind: "supported"; readonly value?: string }
	| { readonly kind: "unsupported" };

/** Context for evaluating XPath expressions within a form. */
export interface EvalContext {
	/** Resolve an absolute path (/data/question_id) to its current value. */
	getValue(path: string): string | undefined;
	/** Resolve a path inside a named secondary instance. Omission means this
	 * evaluation context supports no secondary instances. */
	resolveInstance?(instanceId: string, path: string): InstanceResolution;
	/** Resolve a hashtag ref (#patient/prop, #user/prop, #form/question_id). */
	resolveHashtag(ref: string): string;
	/** Current field path (for '.') */
	contextPath: string;
	/** Current repeat position (for position()) — 1-based */
	position: number;
	/** Exact, context-scoped handlers for machine-emitted carrier expressions.
	 * An unsupported result falls through to Preview's ordinary loud failure. */
	invokeGeneratedFunction?(
		name: string,
		args: readonly XPathValue[],
	): XPathFunctionInvocation;
}

// ── Internal helpers ────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Integer days since Unix epoch for a JS Date, matching CommCare core's
 * `DateUtils.daysSinceEpoch()` — rounds to midnight then divides.
 */
function daysSinceEpoch(d: Date): number {
	/* Encode the browser's LOCAL calendar date at UTC midnight. Core rounds a
	 * Date in the device timezone before computing the epoch-day count, so UTC
	 * fields would move today() a day forward in negative offsets after 00:00Z.
	 * Fields copy via `setUTCFullYear`, never `Date.UTC(year, ...)`, whose
	 * two-digit-year remapping (years 0-99 → 1900-1999) would shift a
	 * year 0001-0099 date nineteen centuries forward. */
	const utcMidnight = new Date(0);
	utcMidnight.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
	return Math.round(utcMidnight.getTime() / MS_PER_DAY);
}
