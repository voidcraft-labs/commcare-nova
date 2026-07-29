// lib/domain/temporalValues.ts
//
// The shapes a CommCare temporal answer actually carries on the wire, and
// the one adaptation Nova's storage schema forces on top of them. Every
// surface that turns a temporal value into something storable reads this
// module, so the form engine, the migration cast, the submission envelope,
// and the data-review editor cannot each invent their own spelling.
//
// Nova emits `xsd:date` / `xsd:time` / `xsd:dateTime` binds
// (`lib/commcare/xform/builder.ts`), so a deployed app's answers are
// JavaRosa `DateData` / `TimeData` / `DateTimeData`. What each writes:
//
//   date      2026-01-15                          DateData::uncast
//   time      14:30:00.000                        TimeData::uncast
//   datetime  2026-01-15T14:30:00.000-05:00       DateTimeData::uncast
//
// (`commcare-core/src/main/java/org/javarosa/core/model/data/*Data.java`.)
// The time/datetime split is deliberate, not an oversight: `TimeData` asks
// for `DateUtils.FORMAT_ISO8601_WALL_TIME`, whose only effect is to set the
// `suppressTimezone` flag on `DateUtils::formatTimeISO8601` so it returns
// before the offset block. A time answer is a WALL CLOCK with no zone; a
// datetime answer carries the offset of the zone it was entered in — the
// device's, and in Web Apps the browser's, since
// `formplayer`'s `SetBrowserValuesAspect::setValues` installs
// `BrowserValuesProvider` (reading `tz_offset_millis`) as the
// `DateUtils` timezone provider before every request.
//
// ── The one place Nova cannot match the wire ──
//
// A `time` case property compiles to `{format: "time"}` and a `datetime` to
// `{format: "date-time"}` (`lib/domain/predicate/jsonSchema.ts`), which
// ajv-formats reads as RFC 3339 — where an offset is REQUIRED. So the naive
// wall clock `14:30:00.000` cannot be stored as-is. Nova therefore appends a
// `Z` STORAGE TAG to a time. The tag is a label on a wall clock, not a claim
// about an instant, and it is only safe because nothing reads a bare time as
// one:
//
//   - `format-date`'s applicability gate is `DATE_DATA_TYPES`
//     (`lib/domain/casePropertyTypes.ts`), which is `{date, datetime}` —
//     a time never reaches the viewer-local renderer.
//   - `NAIVE_TEMPORAL_TEXT_PATTERN` (`lib/case-store/sql/dataTypeTokens.ts`)
//     requires a leading calendar date, so a bare time never reaches the
//     zone pinning either.
//
// Widen either of those to include `time` and the tag silently becomes an
// instant, moving every stored wall clock by the viewer's offset.
//
// The tag is NOT stripped back off on the way in. The form engine holds a
// time exactly as the case store holds it, and the question widget renders
// that value — which it must do anyway, since neither `14:30:00.000` nor
// `14:30:00.000Z` is something to show a person. Stripping on read looked
// tidier (the instance would then hold what the device's instance holds)
// but bought nothing observable: a bare time parses to `null` in the XPath
// evaluator either way and no comparison can see the difference. What it
// cost was real — two separate preload paths and the `#case/<prop>`
// resolver each had to remember to strip, and a single miss meant the same
// property read one way through a field and another through an expression.
//
// Datetime needs no such tag: once the offset is real, the wire shape and
// the storage shape are the same string. The only divergence left is the
// whole-hour offset spelling — `formatTimeISO8601` writes `-05` where this
// module writes `-05:00`. Both denote the same instant and today's
// ajv-formats accepts both, but only the second is RFC 3339 canonical, so
// Nova stores the spelling that cannot be invalidated by a stricter
// validator later.

/** The three kinds of temporal answer, spelled the same way by a field's
 *  `kind` and a case property's `data_type`. */
export type TemporalValueKind = "date" | "time" | "datetime";

/**
 * Calendar date, the one shape that is identical everywhere. Month and day
 * are range-checked but the calendar is not: `2026-02-30` passes here and
 * is caught by the schema, which stays the single authority on conformance.
 */
const DATE_ONLY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * A time-of-day with optional seconds, fractional seconds, and trailing
 * zone designator, captured as one grammar rather than as a clock regex
 * plus a separate designator regex.
 *
 * Splitting them is what makes `2026-01-15` read as a clock carrying a
 * `-15` offset: a designator pattern anchored only at the end has no way
 * to know the text before it was never a time. Requiring the whole
 * fragment to parse at once removes the question.
 *
 * Every field is range-bound, so an hour like `99:00` is text this grammar
 * cannot read rather than a clock it happily rewrites into `99:00:00.000Z`
 * — a shape that looks canonical and that no schema accepts.
 */
const TIME_OF_DAY_RE =
	/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?$/;

/** Midnight, in the wire's own spelling — what a bare date extends to. */
const WIRE_MIDNIGHT = "00:00:00.000";

const pad = (value: number, width: number): string =>
	String(value).padStart(width, "0");

/**
 * Normalize a time-of-day fragment to the wire's `HH:MM:SS.mmm`, dropping
 * any zone designator it carried.
 *
 * Milliseconds are padded rather than stripped because JavaRosa always
 * writes three of them, and matching that costs nothing: Postgres `::time`
 * — the cast a `time` property compiles through
 * (`POSTGRES_CAST_FOR_DATA_TYPE`) — parses both precisions to the same
 * value, so rows written before and after this rule compare and sort
 * identically with no migration.
 *
 * A fragment this cannot read is returned trimmed and unchanged; the
 * schema, not this function, is the authority on what conforms.
 */
export function wireTimeOfDay(fragment: string): string {
	const parsed = parseTimeOfDay(fragment);
	return parsed === null ? fragment.trim() : parsed.clock;
}

/** A time fragment split into its wall clock and its zone designator, or
 *  `null` when the text is not a time at all. */
function parseTimeOfDay(
	fragment: string,
): { clock: string; designator: string } | null {
	const match = TIME_OF_DAY_RE.exec(fragment.trim());
	if (match === null) return null;
	const [, hours, minutes, seconds, fraction, designator] = match;
	return {
		clock: `${pad(Number(hours), 2)}:${minutes}:${seconds ?? "00"}.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}`,
		designator: canonicalDesignator(designator ?? ""),
	};
}

/**
 * A zone designator in the one spelling this module stores, `±HH:MM`.
 *
 * ISO 8601 also admits `-05` and `-0530`, and both reach here from imported
 * data, but RFC 3339 — which is what ajv-formats reads a `format: "time"` /
 * `"date-time"` against — admits neither. A designator that survived the
 * grammar is therefore rewritten rather than passed through, so every value
 * this module returns is one the storage schema accepts.
 *
 * `Z` and the absent designator are already canonical and pass straight out.
 */
function canonicalDesignator(designator: string): string {
	if (designator === "" || designator === "Z") return designator;
	const digits = designator.slice(1).replace(":", "");
	return `${designator[0]}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2) : "00"}`;
}

/**
 * The stored spelling of a time answer: the wire's wall clock plus the `Z`
 * storage tag the strict `format: "time"` schema requires. A fragment that
 * already carries an offset keeps it — an imported value's own zone is
 * authoritative and this function never overrides one.
 *
 * Text that is not a time comes back untouched, so a value the caller
 * reached here by mistake (a bare date arriving from the `date → time`
 * migration cast, say) still reads as itself in the cast-failure message
 * the person is shown, rather than as a mangled hybrid.
 */
export function storageTimeValue(fragment: string): string {
	const parsed = parseTimeOfDay(fragment);
	if (parsed === null) return fragment.trim();
	return `${parsed.clock}${parsed.designator === "" ? "Z" : parsed.designator}`;
}

/** Per-zone formatter cache — `Intl.DateTimeFormat` construction is the
 *  expensive part, and these are called once per temporal value written. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
	const cached = zoneFormatters.get(zone);
	if (cached !== undefined) return cached;
	// An unrecognized zone falls back to UTC rather than throwing, matching
	// `compileExpression.ts::resolveViewerTimeZone` — the value is
	// client-supplied on the write path too, and a deterministic UTC read
	// beats an exception thrown mid-submission.
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		formatter = zoneFormatter("UTC");
	}
	zoneFormatters.set(zone, formatter);
	return formatter;
}

/** Minutes `zone` is ahead of UTC at a given instant. */
function zoneOffsetMinutesAt(zone: string, instantMs: number): number {
	const parts = zoneFormatter(zone).formatToParts(new Date(instantMs));
	const read = (type: Intl.DateTimeFormatPartTypes): number => {
		const part = parts.find((candidate) => candidate.type === type);
		return part === undefined ? 0 : Number(part.value);
	};
	// `hourCycle: "h23"` should already keep midnight at 0, but ICU has
	// historically reported 24 here and the modulo costs nothing.
	const wallAsUtc = Date.UTC(
		read("year"),
		read("month") - 1,
		read("day"),
		read("hour") % 24,
		read("minute"),
		read("second"),
	);
	return Math.round((wallAsUtc - instantMs) / 60_000);
}

function formatZoneOffset(offsetMinutes: number): string {
	if (offsetMinutes === 0) return "Z";
	const sign = offsetMinutes > 0 ? "+" : "-";
	const magnitude = Math.abs(offsetMinutes);
	return `${sign}${pad(Math.floor(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`;
}

/**
 * The zone designator a wall clock takes in `zone` — the offset in force at
 * the instant that wall clock denotes, not the offset in force today, so a
 * summer date entered in winter still gets its own side of DST.
 *
 * Resolved in two passes because the two facts are mutually dependent: the
 * offset depends on the instant, and the instant depends on the offset. The
 * first pass reads the offset as if the wall clock were UTC, the second
 * re-reads it at the instant that first offset implies.
 *
 * That settles every wall clock except the hour a year a DST jump makes
 * nonexistent or ambiguous, where any implementation has to choose. This
 * one chooses the same readings `Temporal`'s default `compatible`
 * disambiguation does — pinned in the tests, so the day Temporal is
 * Baseline (Safari is the holdout; adopting it now would mean a polyfill in
 * a leaf module every client bundle imports) it can replace this function
 * as a proven no-op.
 */
export function zoneDesignatorForWallTime(wall: string, zone: string): string {
	const asIfUtc = Date.parse(`${wall}Z`);
	if (Number.isNaN(asIfUtc)) return "Z";
	const firstPass = zoneOffsetMinutesAt(zone, asIfUtc);
	return formatZoneOffset(
		zoneOffsetMinutesAt(zone, asIfUtc - firstPass * 60_000),
	);
}

/**
 * The stored — and, offset spelling aside, wire — shape of a datetime
 * answer: `YYYY-MM-DDTHH:MM:SS.mmm` plus the offset of `zone` at that wall
 * clock.
 *
 * `zone` is the caller's decision because the right answer differs by
 * surface, and getting it wrong is invisible until someone reads the value
 * back in another timezone. A value a person just entered takes the
 * VIEWER's zone, because Preview's contract is that the author's browser
 * stands in for the device (`compileTerm.ts`'s `viewerTimeZone`) and the
 * device stamps its own offset. A value being converted server-side with no
 * viewer takes `"UTC"`, the only deterministic reading available there.
 *
 * A value that already carries an offset keeps it and only has its time
 * part padded; a bare calendar date extends to midnight in `zone`; anything
 * unreadable is returned trimmed for the schema to reject.
 */
export function storageDatetimeValue(text: string, zone: string): string {
	const parsed = parseDatetime(text);
	if (parsed === null) return text.trim();
	return `${parsed.wall}${
		parsed.designator === ""
			? zoneDesignatorForWallTime(parsed.wall, zone)
			: parsed.designator
	}`;
}

/** A datetime fragment split into its wall clock and its zone designator,
 *  or `null` when the text is not a date-and-time at all. A bare calendar
 *  date reads as its own midnight, zoneless — the caller stamps it. */
function parseDatetime(
	text: string,
): { wall: string; designator: string } | null {
	const trimmed = text.trim();
	if (DATE_ONLY_RE.test(trimmed)) {
		return { wall: `${trimmed}T${WIRE_MIDNIGHT}`, designator: "" };
	}
	const separator = trimmed.indexOf("T");
	if (separator === -1) return null;
	const datePart = trimmed.slice(0, separator);
	if (!DATE_ONLY_RE.test(datePart)) return null;
	const time = parseTimeOfDay(trimmed.slice(separator + 1));
	if (time === null) return null;
	return { wall: `${datePart}T${time.clock}`, designator: time.designator };
}

/**
 * Whether `value` is ALREADY exactly what this module stores for `kind` —
 * the question a widget asks before rendering a value as human text, and
 * the one the form engine asks before letting an answer reach submission.
 *
 * It is deliberately not `canonicalizer(value) === value`: every
 * canonicalizer here returns unreadable text untouched, so that comparison
 * calls `"sometime tuesday"` a stored time. Readability is checked first
 * and separately, against the same grammar the canonicalizer parses with,
 * so the two can never disagree about what a value is.
 *
 * Shape only. A `2026-02-30` clears every gate here and is rejected by the
 * storage schema, which stays the authority on conformance.
 */
export function isStorageTemporalValue(
	kind: TemporalValueKind,
	value: string,
): boolean {
	switch (kind) {
		case "date":
			return DATE_ONLY_RE.test(value);
		case "time":
			return (
				parseTimeOfDay(value) !== null && storageTimeValue(value) === value
			);
		case "datetime":
			// The zone cannot matter: a value already in storage shape carries
			// its own designator, and `storageDatetimeValue` never overrides one.
			return (
				parseDatetime(value) !== null &&
				storageDatetimeValue(value, "UTC") === value
			);
	}
}
