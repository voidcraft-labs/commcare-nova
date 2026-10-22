import {
	coreDaysSinceEpoch,
	coreRoundDay,
	isCoreCalendarDate,
	type JavaLocalFields,
	javaCalendarDate,
	javaCalendarDays,
	javaLocalClock,
	javaLocalFields,
	javaWallInstant,
	localCalendarDays,
	localMidnight,
} from "./coreDays";
import {
	javaBmpDecimalDigit,
	normalizeJavaIntegerLexical,
} from "./javaInteger";
import type {
	XPathInstance,
	XPathNode,
	XPathRuntimeValue,
} from "./runtimeValues";

/**
 * XPath date value, a first-class type in CommCare's XPath variant: Core's
 * `java.util.Date`, an instant, with the views Core takes of it.
 *
 * `calendarDays` is the local calendar day (in this realm's zone, read when
 * the value is built) as days since 1970-01-01, one per solar day whatever
 * the calendar; its fields are Java's (`coreDays.ts::javaCalendarDate`,
 * Julian before 1582-10-15), which `toISOString` prints as
 * `FunctionUtils.toString(Date)` does. `timeMilliseconds` is the held instant
 * when the value has a clock (`now()`, a datetime answer, parsed datetime
 * text); a date-only value stands for its local midnight, as Core's rounded
 * `Date` does. Numeric coercion reads `coreDays`, Core's own day count
 * (`coreDays.ts`), which differs from the calendar in five Pacific zones.
 */
export class XPathDate {
	/** The local calendar date as days since 1970-01-01 (always an integer). */
	readonly calendarDays: number;
	/** The held instant, when the value carries a clock. */
	readonly timeMilliseconds: number | null;

	private constructor(calendarDays: number, timeMilliseconds: number | null) {
		this.calendarDays = calendarDays;
		this.timeMilliseconds = timeMilliseconds;
	}

	/** A date-only value for a calendar day. */
	static fromCalendarDays(calendarDays: number): XPathDate {
		return new XPathDate(Math.trunc(calendarDays), null);
	}

	/** A value holding an instant, read on this realm's local calendar. */
	static fromInstant(instantMs: number): XPathDate {
		return new XPathDate(localCalendarDays(instantMs), instantMs);
	}

	/** `DateUtils.roundDate`: the date-only value of an instant's local day. */
	static localDateOf(instantMs: number): XPathDate {
		return new XPathDate(localCalendarDays(instantMs), null);
	}

	/** Rebuild a value from its two parts exactly, as the worker protocol
	 * carries them, without re-reading the calendar day in this realm. */
	static fromParts(
		calendarDays: number,
		timeMilliseconds: number | null,
	): XPathDate {
		if (
			!Number.isSafeInteger(calendarDays) ||
			(timeMilliseconds !== null && !Number.isFinite(timeMilliseconds))
		) {
			throw new Error(
				"A Preview date crossed the worker boundary without a whole calendar day and a finite instant.",
			);
		}
		return new XPathDate(calendarDays, timeMilliseconds);
	}

	/** Parse JavaRosa's explicit date/datetime syntax.
	 *
	 * This deliberately does not use the JavaScript Date string parser. Core's
	 * `DateUtils.parseDateTime()` splits and validates the calendar fields
	 * itself, accepts hh:mm plus optional fractional seconds, converts an
	 * explicit offset into the device zone's clock while keeping the authored
	 * calendar date, and resolves that wall clock as `java.util.Calendar` does
	 * (`coreDays.ts::javaWallInstant`).
	 */
	static parse(s: string): XPathDate | null {
		const separator = s.indexOf("T");
		const rawDate = separator === -1 ? s : s.slice(0, separator);
		const date = parseJavaRosaDateFields(rawDate);
		if (date === null) return null;
		if (separator === -1) return XPathDate.fromCalendarDays(date.days);

		const time = parseJavaRosaTimeFields(s.slice(separator + 1), date);
		if (time === null) return null;
		const instant = javaWallInstant({
			year: date.year,
			monthIndex: date.monthIndex,
			day: date.day,
			hour: time.hour,
			minute: time.minute,
			second: time.second,
			millisecond: time.milliseconds,
		});
		// A clock beyond `Date`'s range (about ±273,790 years) has no instant
		// Preview can hold.
		return Number.isFinite(instant) ? XPathDate.fromInstant(instant) : null;
	}

	/**
	 * Read datetime text that names its own offset at exactly that instant,
	 * the way a datetime answer is held: Core's `DateTimeData` of the instant
	 * the person entered, which Nova's canonical storage text records with
	 * the offset of its own instant. No wall clock is re-resolved, so an
	 * answer in a repeated hour keeps the occurrence it was entered at. Text
	 * without an offset, and date-only text, read as Core's cast reads them
	 * (`parse`). The fields are proleptic Gregorian, as
	 * `lib/domain/temporalValues.ts::instantDatetimeValue` writes them, so the
	 * two round-trip every instant.
	 */
	static parseExactInstant(s: string): XPathDate | null {
		const exact = EXACT_INSTANT_TEXT.exec(s);
		if (exact === null) return XPathDate.parse(s);
		const [, year, month, day, hour, minute, second, fraction, zone] = exact;
		const date = parseJavaRosaDateFields(`${year}-${month}-${day}`);
		if (date === null) return null;
		const milliseconds = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
		const hours = Number(hour);
		const minutes = Number(minute);
		const seconds = Number(second ?? "0");
		if (!validTime(hours, minutes, seconds, milliseconds)) return null;
		const wall = new Date(0);
		wall.setUTCFullYear(date.year, date.monthIndex, date.day);
		wall.setUTCHours(hours, minutes, seconds, milliseconds);
		const offsetMinutes = zoneOffsetMinutes(zone ?? "Z");
		if (offsetMinutes === null) return null;
		return XPathDate.fromInstant(wall.getTime() - offsetMinutes * 60_000);
	}

	/** `DateUtils.daysSinceEpoch`: Core's day number of this value, which
	 * `FunctionUtils.toNumeric` gives a Date. It counts the rounded day
	 * (`coreDays.ts::coreRoundDay`), so a day before AD 1 counts as its AD
	 * fold. A day `roundDate` refuses has no number: Core's `daysSinceEpoch`
	 * throws there, and so does this. */
	get coreDays(): number {
		const days = coreDaysSinceEpoch(this.calendarDays);
		if (days === null)
			throw new CoreUnroundableDateError(`the date ${this.toISOString()}`);
		return days;
	}

	/** The instant Core's `Date` holds: the clock when there is one, else the
	 * local midnight of the calendar day. */
	instant(): number {
		return this.timeMilliseconds ?? localMidnight(this.calendarDays);
	}

	/** `DateUtils.roundDate`: the date-only value of the day Core rounds this
	 * one to (`coreDays.ts::coreRoundDay`): the same day from AD 1 on, the AD
	 * fold of an earlier one, and null for a Julian February 29 that Core's
	 * date check refuses, where Core's `roundDate` returns null. */
	rounded(): XPathDate | null {
		const days = coreRoundDay(this.calendarDays);
		return days === null ? null : XPathDate.fromCalendarDays(days);
	}

	/** XPath string coercion of a Date, `FunctionUtils.toString(Date)`
	 * (`DateUtils.formatDate(d, FORMAT_ISO8601)`): the local date in Java's
	 * fields, the year unpadded (year 21 prints `21-06-15`), the time
	 * discarded. `DateData.uncast` writes the same text. */
	toISOString(): string {
		const { year, month, day } = javaCalendarDate(this.calendarDays);
		return `${year}-${pad2(month)}-${pad2(day)}`;
	}

	/** `DateUtils.getFields` of this value in the realm's zone. */
	localFields(): JavaLocalFields {
		return javaLocalFields(this.calendarDays, this.timeMilliseconds);
	}
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * A date CommCare's `DateUtils.roundDate` has no date for: February 29 of a
 * Julian year (before 1582-10-15) that Core's proleptic Gregorian leap rule
 * calls common. Every read Core makes of that null fails, so Preview stops
 * the evaluation where Core's does.
 */
export class CoreUnroundableDateError extends Error {
	/** `what` names the value, as "the date 100-02-29" or "day number -679669". */
	constructor(what: string) {
		super(
			`CommCare has no date for ${what}: it falls on February 29 of a year before 1582 that CommCare's calendar check counts as a common year, so a device stops here too. Try a date in another year.`,
		);
		this.name = "CoreUnroundableDateError";
	}
}

/** `YYYY-MM-DDTHH:MM[:SS[.fff]]` with a `Z` or `±HH[:MM]` designator. */
const EXACT_INSTANT_TEXT =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function zoneOffsetMinutes(designator: string): number | null {
	if (designator === "Z") return 0;
	const sign = designator.startsWith("-") ? -1 : 1;
	const digits = designator.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
	if (hours > 23 || minutes > 59) return null;
	return sign * (hours * 60 + minutes);
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
	// `DateFields.check` validates proleptic Gregorian fields; the day is then
	// the one `GregorianCalendar` gives them, Julian before its cutover.
	if (!isCoreCalendarDate(year, month, day)) return null;
	return {
		year,
		monthIndex: month - 1,
		day,
		days: javaCalendarDays(year, month, day),
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
		// Core takes the leading run of `Character.isDigit` characters and dots,
		// ignores later text, and reads the run with `Double.parseDouble`, which
		// accepts ASCII digits only: a run holding another script's digit, an
		// empty run, or a second dot is refused.
		const secondsPrefix = javaSecondsPrefix(pieces[2] ?? "");
		if (secondsPrefix === "" || /[^0-9.]/.test(secondsPrefix)) return null;
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
	const adjusted = javaLocalClock(utc.getTime() - offsetMinutes * 60_000);
	return {
		hour: adjusted.hour,
		minute: adjusted.minute,
		second: adjusted.second,
		milliseconds: adjusted.millisecond,
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

/** `DateUtils.parseRawTime`'s seconds prefix: digits by
 * `Character.isDigit` (BMP decimal digits) and dots. */
function javaSecondsPrefix(value: string): string {
	let end = 0;
	while (end < value.length) {
		const character = value[end] ?? "";
		if (character !== "." && javaBmpDecimalDigit(character) === undefined) {
			break;
		}
		end += 1;
	}
	return value.slice(0, end);
}

/** Java String.split(regex) discards trailing empty pieces. */
function javaSplit(value: string, separator: string): string[] {
	const pieces = value.split(separator);
	while (pieces.length > 0 && pieces.at(-1) === "") pieces.pop();
	return pieces;
}
