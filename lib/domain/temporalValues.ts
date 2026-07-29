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
// `Z` STORAGE TAG to a time on its way into the case store and strips it on
// the way back out. The tag is a label on a wall clock, not a claim about an
// instant, and it is only safe because nothing reads a bare time as one:
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
// Datetime needs no such tag: once the offset is real, the wire shape and
// the storage shape are the same string. The only divergence left is the
// whole-hour offset spelling — `formatTimeISO8601` writes `-05` where this
// module writes `-05:00`. Both denote the same instant and today's
// ajv-formats accepts both, but only the second is RFC 3339 canonical, so
// Nova stores the spelling that cannot be invalidated by a stricter
// validator later.

/** Calendar date, the one shape that is identical everywhere. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A trailing zone designator: `Z`, `+05`, `-0530`, `+05:30`. */
const ZONE_DESIGNATOR_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** A time-of-day with optional seconds and optional fractional seconds. */
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;

/** A calendar date joined to a time-of-day, with no zone designator. */
const NAIVE_DATETIME_RE =
	/^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/;

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
	const trimmed = fragment.trim();
	const naive = trimmed.replace(ZONE_DESIGNATOR_RE, "");
	const match = TIME_OF_DAY_RE.exec(naive);
	if (match === null) return trimmed;
	const [, hours, minutes, seconds, fraction] = match;
	return `${pad(Number(hours), 2)}:${minutes}:${seconds ?? "00"}.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}`;
}

/**
 * The stored spelling of a time answer: the wire's wall clock plus the `Z`
 * storage tag the strict `format: "time"` schema requires. A fragment that
 * already carries an offset keeps it — an imported value's own zone is
 * authoritative and this function never overrides one.
 */
export function storageTimeValue(fragment: string): string {
	const trimmed = fragment.trim();
	if (ZONE_DESIGNATOR_RE.test(trimmed)) {
		const designator = ZONE_DESIGNATOR_RE.exec(trimmed)?.[0] ?? "";
		return `${wireTimeOfDay(trimmed)}${designator}`;
	}
	return `${wireTimeOfDay(trimmed)}Z`;
}

/**
 * Inverse of the storage tag — a stored time back to the wall clock the
 * form engine and the device both hold. Only the `Z` tag is removed: a
 * value carrying a real offset came from somewhere that meant it, so it is
 * left intact for the reader to interpret rather than silently flattened.
 */
export function wireTimeFromStorage(stored: string): string {
	const trimmed = stored.trim();
	return trimmed.endsWith("Z") ? wireTimeOfDay(trimmed) : trimmed;
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
 * re-reads it at the instant that first offset implies. Every wall clock
 * except the one-hour-a-year that a DST jump makes ambiguous or
 * nonexistent settles after the second pass; those resolve to one of their
 * two legal readings, which is the same latitude the platform takes.
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
	const trimmed = text.trim();
	if (DATE_ONLY_RE.test(trimmed)) {
		const wall = `${trimmed}T${WIRE_MIDNIGHT}`;
		return `${wall}${zoneDesignatorForWallTime(wall, zone)}`;
	}
	const naive = NAIVE_DATETIME_RE.exec(trimmed);
	if (naive !== null) {
		const wall = `${naive[1]}T${wireTimeOfDay(naive[2] as string)}`;
		return `${wall}${zoneDesignatorForWallTime(wall, zone)}`;
	}
	const separator = trimmed.indexOf("T");
	if (separator !== -1 && ZONE_DESIGNATOR_RE.test(trimmed)) {
		const datePart = trimmed.slice(0, separator);
		const timePart = trimmed.slice(separator + 1);
		const designator = ZONE_DESIGNATOR_RE.exec(timePart)?.[0] ?? "";
		return `${datePart}T${wireTimeOfDay(timePart)}${designator}`;
	}
	return trimmed;
}
