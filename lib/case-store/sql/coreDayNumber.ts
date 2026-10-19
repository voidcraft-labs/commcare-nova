// lib/case-store/sql/coreDayNumber.ts
//
// A number read as a date, the way the runtime a reading stands for reads it.
// The two runtimes disagree by design: a device counts fixed days from its own
// local midnight, HQ's search counts calendar days. In 413 of 418 zones the
// two land on the same day; in the five Pacific zones whose 1970 offset differs
// from today's they do not, and Preview shows each reading as its runtime does.

import type { AliasableExpression } from "kysely";
import { expressionBuilder } from "kysely";
import type { CaseReading } from "@/lib/domain/expression/temporalType";
import type { Database } from "./database";
import { javaLocalTimestamp } from "./javaZone";
import { resolveViewerTimeZone } from "./viewerTimeZone";

const eb = expressionBuilder<Database, keyof Database>();

/**
 * `date(n)` for a numeric `n`.
 *
 * - `casedb` and `results` (a device): Core's
 *   `FunctionUtils.java::toDate` truncates `n` toward zero (`toInt`, then
 *   `intValue()`), refuses a value outside the `int` range, and returns
 *   `DateUtils.java::dateAdd(getDate(1970, 1, 1), n)`: the device's local
 *   midnight of 1970-01-01, plus `n` fixed days and half a day, rounded to its
 *   local date. Here: `timezone(z, E + trunc(n) * '24 hours' + '12 hours')::date`
 *   with `E = timezone(z, timestamp '1970-01-01 00:00:00')`, `z` the validated
 *   viewer zone, read as Java reads a zone before 1900 (`javaLocalTimestamp`).
 *   The `integer` cast refuses an out-of-range day as Core does.
 * - `search`: HQ's `value_functions.py::value_to_date` adds calendar days to
 *   `datetime.date(1970, 1, 1)`, which no zone moves:
 *   `date '1970-01-01' + trunc(n)::integer`.
 */
export function compileCoreDayNumber(
	number: AliasableExpression<unknown>,
	reading: CaseReading,
	viewerTimeZone: string | undefined,
): AliasableExpression<unknown> {
	const days = eb.cast(eb.fn("trunc", [eb.cast(number, "numeric")]), "integer");
	if (reading === "search") {
		return eb.cast(
			eb(eb.cast(eb.val("1970-01-01"), "date"), "+", days),
			"date",
		);
	}
	const zone = resolveViewerTimeZone(viewerTimeZone);
	const localEpoch = eb.fn("timezone", [
		eb.val(zone),
		eb.cast(eb.val("1970-01-01 00:00:00"), "timestamp"),
	]);
	const elapsed = eb(eb(fixedHours(24), "*", days), "+", fixedHours(12));
	return eb.cast(
		javaLocalTimestamp(zone, eb(localEpoch, "+", elapsed)),
		"date",
	);
}

/**
 * `datetime(n)` for a numeric `n`: `n` days of elapsed time after the UTC
 * epoch, the same in every reading. HQ's `_value_to_datetime` adds
 * `timedelta(days=n)` to the naive epoch and reads it as UTC; part 04's device
 * lowering is `n * 86400000000` microseconds. Hours, not `'1 day'`, because a
 * day interval follows the session zone's daylight-saving changes.
 */
export function compileEpochDayInstant(
	number: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	return eb(
		eb.cast(eb.val("1970-01-01 00:00:00+00"), "timestamptz"),
		"+",
		eb(fixedHours(24), "*", eb.cast(number, "float8")),
	);
}

/** A fixed interval of whole hours, which no zone's daylight saving moves. */
function fixedHours(hours: number): AliasableExpression<unknown> {
	return eb.fn("make_interval", [
		eb.lit(0),
		eb.lit(0),
		eb.lit(0),
		eb.lit(0),
		eb.lit(hours),
	]);
}
