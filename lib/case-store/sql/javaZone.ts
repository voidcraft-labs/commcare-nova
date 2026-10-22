// lib/case-store/sql/javaZone.ts
//
// A device's zone, as `java.util.TimeZone` reads it, in SQL. Java keeps a
// zone's history only from 1900-01-01T00:00:00Z and reads every earlier
// instant at the zone's current standard offset
// (`lib/domain/javaZoneOffset.ts`); Postgres's `timezone()` follows the tzdb
// all the way back, local mean time included (Kolkata's +5:21:10, Kiritimati's
// -10:29:20). Every place the case store reads a value the way a device does,
// in the viewer's zone, goes through these three. A reading that stands for
// HQ's servers keeps Postgres's own `timezone()` at UTC, where the two agree.

import type { AliasableExpression } from "kysely";
import { expressionBuilder } from "kysely";
import type { Database } from "./database";

const eb = expressionBuilder<Database, keyof Database>();

/** 1900-01-01T00:00:00Z, the first instant Java's zone history holds. */
const JAVA_ZONE_HISTORY_START = "1900-01-01 00:00:00+00";

const historyStart = (): AliasableExpression<unknown> =>
	eb.cast(eb.val(JAVA_ZONE_HISTORY_START), "timestamptz");

/**
 * An instant's wall clock in `zone` as `java.util.TimeZone` reads it, a
 * `timestamp`: the zone's history from 1900-01-01T00:00Z on, and before it the
 * zone's standard offset, where Postgres's own `timezone()` would read local
 * mean time.
 */
export function javaLocalTimestamp(
	zone: string,
	instant: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	if (zone === "UTC") return eb.fn("timezone", [eb.val(zone), instant]);
	return eb
		.case()
		.when(instant, "<", historyStart())
		.then(
			eb(
				eb.fn("timezone", [eb.val("UTC"), instant]),
				"+",
				standardOffset(zone),
			),
		)
		.else(eb.fn("timezone", [eb.val(zone), instant]))
		.end();
}

/**
 * The offset `java.util.TimeZone` gives `zone` at an instant, as whole minutes
 * east of UTC, truncated toward zero as Java's `int` division truncates
 * (`DateUtils.getFields` reads `timezoneOffset` in minutes): the format-date
 * `%Z` offset.
 */
export function javaOffsetMinutes(
	zone: string,
	instant: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const offset = eb(
		javaLocalTimestamp(zone, instant),
		"-",
		eb.fn("timezone", [eb.val("UTC"), instant]),
	);
	return eb.cast(
		eb.fn("trunc", [
			eb(eb.fn("date_part", [eb.val("epoch"), offset]), "/", eb.val(60)),
		]),
		"integer",
	);
}

/**
 * The instant `java.util.Calendar` gives a wall clock (a `timestamp`) in
 * `zone`, a `timestamptz`. Java resolves a wall clock through
 * `ZoneInfo.getOffsetsByWall`: the offset of the last transition whose wall
 * start (its instant plus the offset that begins there) is at or before the
 * clock, and the standard offset before the first. Its first transition is
 * the 1900 cutoff itself, from the standard offset to the tzdb's. After it,
 * Postgres's `timezone()` resolves a wall clock the same way: a repeated
 * clock at its later reading, a skipped one by the offset before the gap.
 *
 * So the tzdb's reading stands when it lands at or after the cutoff, and the
 * standard offset's otherwise: where the cutoff repeats a wall clock (Kolkata's
 * 8m50s, Kiritimati's whole 1900-01-01) the later reading is the tzdb's, and
 * where it skips one the clock moves forward past the gap at the standard
 * offset.
 */
export function javaWallInstant(
	zone: string,
	wallClock: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const tzdb = eb.fn("timezone", [eb.val(zone), wallClock]);
	if (zone === "UTC") return tzdb;
	return eb
		.case()
		.when(tzdb, ">=", historyStart())
		.then(tzdb)
		.else(
			eb.fn("timezone", [
				eb.val("UTC"),
				eb(wallClock, "-", standardOffset(zone)),
			]),
		)
		.end();
}

/** `zone`'s standard offset as an interval: the smaller of its offsets on
 *  2025-01-01 and 2025-07-01 (`lib/domain/javaZoneOffset.ts`). */
function standardOffset(zone: string): AliasableExpression<unknown> {
	const offsetAt = (probe: string) =>
		eb(
			eb.fn("timezone", [
				eb.val(zone),
				eb.cast(eb.val(`${probe} 00:00:00+00`), "timestamptz"),
			]),
			"-",
			eb.cast(eb.val(`${probe} 00:00:00`), "timestamp"),
		);
	return eb.fn("least", [offsetAt("2025-01-01"), offsetAt("2025-07-01")]);
}
