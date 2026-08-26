import { normalizeJavaIntegerLexical } from "./javaInteger";
import type {
	XPathInstance,
	XPathNode,
	XPathRuntimeValue,
} from "./runtimeValues";

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

	/** Parse JavaRosa's explicit date/datetime syntax.
	 *
	 * This deliberately does not use the JavaScript Date string parser. Core's
	 * DateUtils.parseDateTime() splits and validates the calendar fields itself,
	 * accepts hh:mm plus optional fractional seconds, and applies an explicit
	 * timezone to the clock while retaining the authored calendar date.
	 */
	static parse(s: string): XPathDate | null {
		const separator = s.indexOf("T");
		const rawDate = separator === -1 ? s : s.slice(0, separator);
		const date = parseJavaRosaDateFields(rawDate);
		if (date === null) return null;
		if (separator === -1) return XPathDate.fromDays(date.days);

		const time = parseJavaRosaTimeFields(s.slice(separator + 1), date);
		if (time === null) return null;
		return XPathDate.fromJSDate(
			localDate(date.year, date.monthIndex, date.day, time),
		);
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
	| { readonly kind: "handled"; readonly value: XPathRuntimeValue }
	| { readonly kind: "unsupported" };

/** Explicit result from a secondary-instance resolver. Missing values inside
 * a known instance are distinct from an unsupported namespace. */
export type InstanceResolution =
	| { readonly kind: "supported"; readonly value?: string }
	| { readonly kind: "unsupported" };

/** Context for evaluating XPath expressions within a form. */
export interface EvalContext {
	/** Active CommCare form locale used by locale-sensitive runtime helpers. */
	locale?: string;
	/** Resolve an absolute path (/data/question_id) to its current value. */
	getValue(path: string): string | undefined;
	/** Resolve a path inside a named secondary instance. Omission means this
	 * evaluation context supports no secondary instances. */
	resolveInstance?(instanceId: string, path: string): InstanceResolution;
	/** Structural main instance used by nodeset-aware path evaluation. */
	mainInstance?: XPathInstance;
	/** Resolve a complete named secondary instance. */
	resolveXPathInstance?(instanceId: string): XPathInstance | undefined;
	/** Concrete node against which relative paths and bare position() run. */
	contextNode?: XPathNode;
	/** Captured outer node used by current() while predicates rescope context. */
	originalContextNode?: XPathNode;
	/** Nodeset-aware identity resolver. Falls back to resolveHashtag when absent. */
	resolveHashtagValue?(ref: string): XPathRuntimeValue;
	/** Resolve a hashtag ref (#patient/prop, #user/prop, #form/question_id). */
	resolveHashtag(ref: string): string;
	/** Current field path (for '.') */
	contextPath: string;
	/** Current predicate position, 1-based. Outside a predicate this should be
	 * undefined and position() derives the context node's zero-based index. */
	position: number | undefined;
	/** Exact, context-scoped handlers for machine-emitted carrier expressions.
	 * An unsupported result falls through to Preview's ordinary loud failure. */
	invokeGeneratedFunction?(
		name: string,
		args: readonly XPathValue[],
	): XPathFunctionInvocation;
}

// ── Internal helpers ────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

interface ParsedDateFields {
	readonly year: number;
	readonly monthIndex: number;
	readonly day: number;
	readonly days: number;
}

interface ParsedTimeFields {
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly milliseconds: number;
}

function parseJavaInteger(value: string): number | null {
	const normalized = normalizeJavaIntegerLexical(value);
	if (normalized === undefined) return null;
	const parsed = Number(normalized);
	return Number.isInteger(parsed) &&
		parsed >= -2_147_483_648 &&
		parsed <= 2_147_483_647
		? parsed
		: null;
}

/** DateUtils.parseDateAndStore(), including its no-trimming behavior. */
function parseJavaRosaDateFields(value: string): ParsedDateFields | null {
	const pieces = javaSplit(value, "-");
	if (pieces.length !== 3) return null;
	const year = parseJavaInteger(pieces[0] ?? "");
	const month = parseJavaInteger(pieces[1] ?? "");
	const day = parseJavaInteger(pieces[2] ?? "");
	if (year === null || month === null || day === null) return null;

	// Validate via UTC fields so daylight-saving transitions cannot normalize
	// an otherwise valid calendar date. setUTCFullYear avoids JS's 1900 remap
	// for years 0000-0099.
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	if (
		Number.isNaN(date.getTime()) ||
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return {
		year,
		monthIndex: month - 1,
		day,
		days: Math.round(date.getTime() / MS_PER_DAY),
	};
}

/** DateUtils.parseTimeAndStore()/parseRawTime() at pinned Core. */
function parseJavaRosaTimeFields(
	value: string,
	date: ParsedDateFields,
): ParsedTimeFields | null {
	if (value.length === 0) return null;
	let rawTime = value;
	let offsetMinutes: number | null = null;

	if (rawTime.endsWith("Z")) {
		rawTime = rawTime.slice(0, -1);
		offsetMinutes = 0;
	} else if (rawTime.includes("+") || rawTime.includes("-")) {
		const hasPlus = rawTime.includes("+");
		const pieces = javaSplit(rawTime, hasPlus ? "+" : "-");
		if (pieces.length < 2) return null;
		rawTime = pieces[0] ?? "";
		const offsetPieces = javaSplit(pieces[1] ?? "", ":");
		if ((pieces[1] ?? "").includes(":") && offsetPieces.length < 2) {
			return null;
		}
		const hours = parseJavaInteger(offsetPieces[0] ?? "");
		const minutes =
			offsetPieces.length > 1 ? parseJavaInteger(offsetPieces[1] ?? "") : 0;
		if (hours === null || minutes === null) return null;
		offsetMinutes = (hasPlus ? 1 : -1) * (hours * 60 + minutes);
	}

	const pieces = javaSplit(rawTime, ":");
	if (pieces.length !== 2 && pieces.length !== 3) return null;
	const hour = parseJavaInteger(pieces[0] ?? "");
	const minute = parseJavaInteger(pieces[1] ?? "");
	if (hour === null || minute === null) return null;

	let second = 0;
	let milliseconds = 0;
	if (pieces.length === 3) {
		// Core consumes the leading run of digits/dots and ignores later text.
		const secondsPrefix = /^[0-9.]*/.exec(pieces[2] ?? "")?.[0] ?? "";
		if (secondsPrefix === "") return null;
		const fractionalSeconds = Number(secondsPrefix);
		if (!Number.isFinite(fractionalSeconds)) return null;
		second = Math.trunc(fractionalSeconds);
		milliseconds = Math.trunc(1000 * (fractionalSeconds - second));
	}
	if (!validTime(hour, minute, second, milliseconds)) return null;

	if (offsetMinutes === null) return { hour, minute, second, milliseconds };

	// Core first interprets the authored fields in UTC, subtracts the authored
	// offset, converts that instant into the device timezone, then copies only
	// the resulting HMS fields back into the original Y-M-D fields.
	const utc = new Date(0);
	utc.setUTCHours(hour, minute, second, milliseconds);
	utc.setUTCFullYear(date.year, date.monthIndex, date.day);
	const adjusted = new Date(utc.getTime() - offsetMinutes * 60_000);
	return {
		hour: adjusted.getHours(),
		minute: adjusted.getMinutes(),
		second: adjusted.getSeconds(),
		milliseconds: adjusted.getMilliseconds(),
	};
}

function validTime(
	hour: number,
	minute: number,
	second: number,
	milliseconds: number,
): boolean {
	return (
		hour >= 0 &&
		hour <= 23 &&
		minute >= 0 &&
		minute <= 59 &&
		second >= 0 &&
		second <= 59 &&
		milliseconds >= 0 &&
		milliseconds <= 999
	);
}

function localDate(
	year: number,
	monthIndex: number,
	day: number,
	time: ParsedTimeFields,
): Date {
	const result = new Date(0);
	result.setFullYear(year, monthIndex, day);
	result.setHours(time.hour, time.minute, time.second, time.milliseconds);
	return result;
}

/** Java String.split(regex) discards trailing empty pieces. */
function javaSplit(value: string, separator: string): string[] {
	const pieces = value.split(separator);
	while (pieces.length > 0 && pieces.at(-1) === "") pieces.pop();
	return pieces;
}

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
