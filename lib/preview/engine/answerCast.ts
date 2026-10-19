/**
 * The cast CommCare Core applies to every value a setvalue writes, ported.
 *
 * `org/javarosa/core/model/actions/SetValueAction.java::processAction`
 * evaluates the value, shapes it for the target node with
 * `Recalculate.wrapData(result, dataType)`, then casts the shaped text with
 * `AnswerDataFactory.templateByDataType(dataType).cast(val.uncast())`. A
 * cast that throws stops the form from opening (or, for a repeat insert's
 * setvalue, stops the insert). A blank result never reaches the cast. A
 * `calculate` never casts (`Recalculate.apply` stores the wrapped value),
 * so nothing here runs for one.
 *
 * Three steps, each one Core symbol:
 * - `coreAnswerType`: the node's data type (`XFormParser.getDataType`, then
 *   `applyControlProperties` turning a select's text node into a choice).
 * - `setvalueText`: `Recalculate.wrapData(result, dataType).uncast()`, the
 *   text the cast receives.
 * - `castAnswerText`: the cast itself, and the text Preview then holds,
 *   which is the text Core's held value uncasts to.
 */

import type { FieldBindType } from "@/lib/commcare/xform/bindType";
import type { FieldKind, Uuid } from "@/lib/domain";
import { openJdk17DoubleToString } from "@/lib/domain/expression/openJdk17DoubleString";
import {
	instantDatetimeValue,
	storageTimeValue,
} from "@/lib/domain/temporalValues";
import { javaZoneNameInstant } from "@/lib/preview/xpath/coreDays";
import { parseJavaDouble } from "@/lib/preview/xpath/javaDouble";
import { normalizeJavaIntegerLexical } from "@/lib/preview/xpath/javaInteger";
import { javaRosaSplitOnSpaces } from "@/lib/preview/xpath/javaString";
import {
	isXPathDate,
	XPathDate,
	type XPathValue,
} from "@/lib/preview/xpath/types";

/** Core's data type of an answer node, as far as Nova's binds reach. */
export type CoreAnswerType =
	| "text"
	| "int"
	| "decimal"
	| "date"
	| "time"
	| "datetime"
	| "geopoint"
	| "choice"
	| "choice-list"
	/** BARCODE, BINARY and untyped nodes: `UncastData`, which never refuses. */
	| "untyped";

/** The answer types whose cast can refuse a value. */
export type RefusingAnswerType = Extract<
	CoreAnswerType,
	"int" | "decimal" | "date" | "time" | "datetime" | "geopoint"
>;

/** `XFormParser.typeMappings` over every bind type Nova emits. */
const CORE_TYPE_BY_BIND: Readonly<Record<FieldBindType, CoreAnswerType>> = {
	"xsd:string": "text",
	"xsd:int": "int",
	"xsd:double": "decimal",
	"xsd:date": "date",
	"xsd:time": "time",
	"xsd:dateTime": "datetime",
	geopoint: "geopoint",
	barcode: "untyped",
	binary: "untyped",
};

/**
 * The data type Core gives a field's node. A select's control turns its text
 * (or untyped) node into a choice (`XFormParser.applyControlProperties`), so
 * the kind is read beside the bind.
 */
export function coreAnswerType(
	bindType: FieldBindType | null,
	kind: FieldKind,
): CoreAnswerType {
	const type = bindType === null ? "untyped" : CORE_TYPE_BY_BIND[bindType];
	if (type === "text" || type === "untyped") {
		if (kind === "single_select") return "choice";
		if (kind === "multi_select") return "choice-list";
	}
	return type;
}

const INT_MIN = -2_147_483_648;
const INT_MAX = 2_147_483_647;
const LONG_MIN = BigInt("-9223372036854775808");
const LONG_MAX = BigInt("9223372036854775807");

/** Java's `(long) d` for a non-NaN double: truncation, saturating. */
function javaLong(value: number): bigint {
	if (value === Number.POSITIVE_INFINITY) return LONG_MAX;
	if (value === Number.NEGATIVE_INFINITY) return LONG_MIN;
	const truncated = BigInt(Math.trunc(value));
	return truncated < LONG_MIN
		? LONG_MIN
		: truncated > LONG_MAX
			? LONG_MAX
			: truncated;
}

/** Java's `(int) d` for a non-NaN double: truncation, saturating. */
function javaInt(value: number): number {
	const truncated = Math.trunc(value);
	const saturated =
		truncated < INT_MIN ? INT_MIN : truncated > INT_MAX ? INT_MAX : truncated;
	return saturated === 0 ? 0 : saturated;
}

/** `Recalculate.wrapData`'s Double branch, uncast. */
function numberText(value: number, type: CoreAnswerType): string {
	// An INTEGER node always takes IntegerData((int) d).
	if (type === "int") return String(javaInt(value));
	const long = javaLong(value);
	const integral = Math.abs(value - Number(long)) < 1e-9;
	if (integral && long >= BigInt(INT_MIN) && long <= BigInt(INT_MAX)) {
		return String(javaInt(value));
	}
	// LongData prints its long; DecimalData prints Double.toString.
	return integral ? long.toString() : openJdk17DoubleToString(value);
}

const pad = (value: number, width: number): string =>
	String(value).padStart(width, "0");

/** `DateUtils.formatTimeISO8601(fields, true)`: the device's wall clock. */
function wallTimeText(value: XPathDate): string {
	const local = value.localFields();
	return `${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(
		local.second,
		2,
	)}.${pad(local.millisecond, 3)}`;
}

/**
 * `DateTimeData.uncast`: `DateUtils.formatDateTime(d, FORMAT_ISO8601)`, the
 * device's wall clock in Java's calendar fields (the year unpadded) stamped
 * with the offset in force at that day's local midnight
 * (`TimeZone.getOffset(era, y, m, d, dow, 0)`), which is not always the
 * offset of the instant itself. The offset prints in whole minutes.
 */
function coreDateTimeText(value: XPathDate): string {
	const midnight = XPathDate.fromCalendarDays(value.calendarDays).localFields();
	const offset = Math.trunc(midnight.offsetMinutes);
	const magnitude = Math.abs(offset);
	const zone =
		offset === 0
			? "Z"
			: `${offset > 0 ? "+" : "-"}${pad(Math.floor(magnitude / 60), 2)}${
					magnitude % 60 === 0 ? "" : `:${pad(magnitude % 60, 2)}`
				}`;
	return `${value.toISOString()}T${wallTimeText(value)}${zone}`;
}

const JAVA_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const JAVA_MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/**
 * `String.valueOf(java.util.Date)`: `EEE MMM dd HH:mm:ss zzz yyyy` in the
 * device's zone and calendar. The zone's short name comes from the browser's
 * English names, which match Java's for zones with a common abbreviation and
 * spell the rest as an offset.
 */
function javaDateString(value: XPathDate): string {
	const local = value.localFields();
	// Before 1900 Java names the zone's standard time (`javaZoneNameInstant`);
	// a day beyond `Date`'s future range takes the name at the edge.
	const instant = javaZoneNameInstant(Math.min(8.64e15, value.instant()));
	const zone =
		new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
			.formatToParts(new Date(instant))
			.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
	return `${JAVA_DAYS[local.dayOfWeek]} ${JAVA_MONTHS[local.month - 1]} ${pad(
		local.day,
		2,
	)} ${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(
		local.second,
		2,
	)} ${zone} ${local.year}`;
}

/**
 * `Recalculate.wrapData(result, dataType).uncast()`: the text a setvalue's
 * cast receives. `undefined` is `wrapData`'s `null`, an empty string or a
 * NaN number, which leaves the node blank and never casts.
 */
export function setvalueText(
	result: XPathValue,
	type: CoreAnswerType,
): string | undefined {
	if (result === "") return undefined;
	if (typeof result === "number" && Number.isNaN(result)) return undefined;
	if (typeof result === "boolean") return result ? "1" : "0";
	if (typeof result === "number") return numberText(result, type);
	if (type === "choice" || type === "choice-list") {
		return isXPathDate(result) ? javaDateString(result) : result;
	}
	if (typeof result === "string") return result;
	// A Date: DateTimeData into a datetime node, TimeData into a time node,
	// DateData (its local calendar date) into every other node.
	if (type === "datetime") return coreDateTimeText(result);
	if (type === "time") return wallTimeText(result);
	return result.toISOString();
}

/** The outcome of one cast: the text Preview holds, or Core's refusal. */
export type AnswerCast =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false };

const REFUSED: AnswerCast = { ok: false };

/** `Integer.parseInt`: Java's integer grammar over `int`'s range, and the
 * value `IntegerData` holds (never a negative zero). */
function javaParseInt(text: string): number | undefined {
	const normalized = normalizeJavaIntegerLexical(text);
	if (normalized === undefined) return undefined;
	const value = Number(normalized);
	return value >= INT_MIN && value <= INT_MAX ? value + 0 : undefined;
}

/**
 * `GeoPointData.cast`: `DataUtil.splitOnSpaces`, at least two tokens (a
 * fifth throws on the fixed four-slot array), each read by
 * `Double.parseDouble`. Latitude and longitude are not range-checked.
 */
function castsToGeopoint(text: string): boolean {
	const tokens = javaRosaSplitOnSpaces(text);
	return (
		tokens.length >= 2 &&
		tokens.length <= 4 &&
		tokens.every((token) => parseJavaDouble(token) !== undefined)
	);
}

/**
 * Core's cast of `text` into a node of `type`, and the text Preview holds
 * after it.
 *
 * A date holds its normalized calendar date (`DateData`), and a date and
 * time the instant `DateUtils.parseDateTime` resolves, written as Nova's
 * canonical text in `zone` (`DateTimeData`). A time holds its written clock
 * in Nova's stored spelling (see the time arm). A whole number holds
 * `IntegerData`'s text and a number `DecimalData`'s (each `uncast`: the
 * parsed value printed by Java, so `007` holds `7` and a number's `5` holds
 * `5.0`), since a later setvalue's uncast and the submission both carry
 * that text, never the one written. A location keeps the text as written
 * once Core accepts it. A multiple choice holds its tokens joined by single
 * spaces (`SelectMultiData`). Text, single choices and untyped nodes never
 * refuse.
 *
 * `zone` is this realm's zone, the one `XPathDate` reads calendars in.
 */
export function castAnswerText(
	type: CoreAnswerType,
	text: string,
	zone: string,
): AnswerCast {
	switch (type) {
		case "text":
		case "choice":
		case "untyped":
			return { ok: true, text };
		case "choice-list":
			return {
				ok: true,
				text: javaRosaSplitOnSpaces(text)
					.filter((token) => token !== "")
					.join(" "),
			};
		case "int": {
			const value = javaParseInt(text);
			return value === undefined ? REFUSED : { ok: true, text: String(value) };
		}
		case "decimal": {
			const value = parseJavaDouble(text);
			return value === undefined
				? REFUSED
				: { ok: true, text: openJdk17DoubleToString(value) };
		}
		case "geopoint":
			return castsToGeopoint(text) ? { ok: true, text } : REFUSED;
		case "date": {
			// `DateUtils.parseDate` reads the whole text as `Y-M-D`: a `T` is no
			// digit, so a datetime's tail fails `Integer.parseInt`.
			if (text.includes("T")) return REFUSED;
			const parsed = XPathDate.parse(text);
			return parsed === null
				? REFUSED
				: { ok: true, text: parsed.toISOString() };
		}
		case "time":
			// `DateUtils.parseTime(s, true)` parses into a fresh `DateFields`,
			// whose date is 1970-01-01, exactly as `parseDateTime` parses the
			// time after that date. Core then holds the clock converted into the
			// device's zone; Nova's stored times carry a `Z` storage tag rather
			// than a zone, so holding the converted clock would move a saved time
			// by the viewer's offset on every save. The written clock is held.
			return XPathDate.parse(`1970-01-01T${text}`) === null
				? REFUSED
				: { ok: true, text: storageTimeValue(text) };
		case "datetime": {
			const parsed = XPathDate.parse(text);
			return parsed === null
				? REFUSED
				: { ok: true, text: instantDatetimeValue(parsed.instant(), zone) };
		}
	}
}

/** The zone this realm reads calendars in, which `castAnswerText` takes. */
export function realmTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Which setvalue Core refused, which decides what stops. */
export type SetvalueRefusalCause =
	/** A selected case's saved value written into its question at form open. */
	| "preload"
	/** A question's starting value at form open, or after an edit to it. */
	| "starting-value"
	/** A starting value inside a new repeat entry: only the insert stops. */
	| "repeat-insert";

/** What a refused setvalue names: plain data, so it crosses the worker and
 * the agent tool boundary as it is. */
export interface SetvalueRefusalDetails {
	readonly cause: SetvalueRefusalCause;
	/** The question the setvalue targets. */
	readonly fieldUuid: Uuid;
	/** Its concrete instance path. */
	readonly path: string;
	/** The text Core's cast received. */
	readonly value: string;
	readonly answerType: RefusingAnswerType;
	/** A preload's case property. */
	readonly caseType?: string;
	readonly property?: string;
	readonly caseId?: string;
	/** A repeat insert's repeat. */
	readonly repeatUuid?: Uuid;
}

/**
 * Core's refusal of a setvalue (`SetValueAction.processAction`'s
 * `XPathTypeMismatchException`, or the uncaught exception a few malformed
 * texts raise inside the cast). It is author data the running app turns
 * away, never a Preview fault.
 */
export class SetvalueRefusal extends Error {
	readonly details: SetvalueRefusalDetails;

	constructor(details: SetvalueRefusalDetails) {
		super(
			`CommCare refuses “${details.value}” for the question at ${details.path}: it isn't ${details.answerType} text.`,
		);
		this.name = "SetvalueRefusal";
		this.details = details;
	}
}

/** Whether a refused cast can come from this answer type. */
export function isRefusingAnswerType(
	type: CoreAnswerType,
): type is RefusingAnswerType {
	return (
		type === "int" ||
		type === "decimal" ||
		type === "date" ||
		type === "time" ||
		type === "datetime" ||
		type === "geopoint"
	);
}
