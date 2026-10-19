/**
 * Core's setvalue cast, one row per outcome, read from Core's code at the
 * pin: `SetValueAction.processAction`, `Recalculate.wrapData`,
 * `AnswerDataFactory.templateByDataType` and each `*Data.cast` / `uncast`,
 * `DateUtils.parseDate` / `parseDateTime` / `parseTime`, and JDK 17's
 * `Integer.parseInt` and `Double.parseDouble`. Temporal rows hold in a
 * device in `America/New_York`.
 *
 * `held` is the text Preview keeps after Core accepts the cast: Core's own
 * held text for a date and a date and time (the instant, in Nova's
 * spelling), and the written text for a time, a whole number, a number and
 * a location.
 */

import type { CoreAnswerType } from "../../answerCast";

export const ANSWER_CAST_ZONE = "America/New_York";

export type AnswerCastOutcome =
	| { readonly held: string }
	| { readonly refused: true };

export interface AnswerCastRow {
	readonly type: CoreAnswerType;
	readonly text: string;
	readonly expect: AnswerCastOutcome;
}

const held = (text: string): AnswerCastOutcome => ({ held: text });
const refused: AnswerCastOutcome = { refused: true };

export const ANSWER_CASTS: readonly AnswerCastRow[] = [
	// Integer.parseInt: a sign, leading zeros and BMP decimal digits.
	{ type: "int", text: "+7", expect: held("+7") },
	{ type: "int", text: "007", expect: held("007") },
	{ type: "int", text: "٧", expect: held("٧") },
	{ type: "int", text: "-2147483648", expect: held("-2147483648") },
	{ type: "int", text: "2147483647", expect: held("2147483647") },
	{ type: "int", text: "2147483648", expect: refused },
	{ type: "int", text: " 5", expect: refused },
	{ type: "int", text: "1.5", expect: refused },
	{ type: "int", text: "1e3", expect: refused },
	{ type: "int", text: "+", expect: refused },
	// Double.parseDouble: trimmed, a suffix only on a numeric literal.
	{ type: "decimal", text: " 1e3d\t", expect: held(" 1e3d\t") },
	{ type: "decimal", text: "0x1p3", expect: held("0x1p3") },
	{ type: "decimal", text: "NaN", expect: held("NaN") },
	{ type: "decimal", text: "-Infinity", expect: held("-Infinity") },
	{ type: "decimal", text: "NaNf", expect: refused },
	{ type: "decimal", text: "Infinityd", expect: refused },
	{ type: "decimal", text: "0x10", expect: refused },
	{ type: "decimal", text: ".", expect: refused },
	{ type: "decimal", text: "1e", expect: refused },
	{ type: "decimal", text: "1,5", expect: refused },
	// DateUtils.parseDate: three dash-split integers forming a real date.
	{ type: "date", text: "2024-02-29", expect: held("2024-02-29") },
	{ type: "date", text: "+2026-1-5", expect: held("2026-01-05") },
	{ type: "date", text: "2026-01-05-", expect: held("2026-01-05") },
	{ type: "date", text: "2026-02-29", expect: refused },
	{ type: "date", text: "2026-13-01", expect: refused },
	{ type: "date", text: "2026-01-05T10:00", expect: refused },
	{ type: "date", text: " 2026-01-05", expect: refused },
	// DateUtils.parseDateTime: the written date is kept, an explicit offset
	// is converted into the device's clock, and Calendar resolves it.
	{
		type: "datetime",
		text: "2026-01-02T04:30:00.000Z",
		expect: held("2026-01-02T23:30:00.000-05:00"),
	},
	{
		type: "datetime",
		text: "2026-11-01T01:45:00.000-04:00",
		expect: held("2026-11-01T01:45:00.000-05:00"),
	},
	{
		type: "datetime",
		text: "2026-03-08T02:30:00",
		expect: held("2026-03-08T03:30:00.000-04:00"),
	},
	{
		type: "datetime",
		text: "2026-01-05",
		expect: held("2026-01-05T00:00:00.000-05:00"),
	},
	{ type: "datetime", text: "2026-01-02 04:30Z", expect: refused },
	{ type: "datetime", text: "2026-01-01T23:59:60Z", expect: refused },
	{ type: "datetime", text: "2026-01-01T", expect: refused },
	{ type: "datetime", text: "2026-01-01T10:00+", expect: refused },
	{ type: "datetime", text: "2026-01-01T10", expect: refused },
	// DateUtils.parseTime(s, true): a clock, with any offset applied.
	{ type: "time", text: "08:45:00Z", expect: held("08:45:00.000Z") },
	{ type: "time", text: "8:45", expect: held("08:45:00.000Z") },
	{
		type: "time",
		text: "08:45:00.5+05:30",
		expect: held("08:45:00.500+05:30"),
	},
	{ type: "time", text: "25:00", expect: refused },
	{ type: "time", text: "12:00:60", expect: refused },
	{ type: "time", text: "10:00+", expect: refused },
	{ type: "time", text: "noon", expect: refused },
	// GeoPointData.cast: two to four space-split doubles, unranged.
	{ type: "geopoint", text: "91 0", expect: held("91 0") },
	{ type: "geopoint", text: "1\t 2", expect: held("1\t 2") },
	{ type: "geopoint", text: "1 2 ", expect: held("1 2 ") },
	{
		type: "geopoint",
		text: "NaN Infinity 0x1p1 4",
		expect: held("NaN Infinity 0x1p1 4"),
	},
	{ type: "geopoint", text: " 1 2", expect: refused },
	{ type: "geopoint", text: "1 2 3 4 5", expect: refused },
	{ type: "geopoint", text: "1", expect: refused },
	{ type: "geopoint", text: "1 north", expect: refused },
	// Never refused.
	{ type: "choice-list", text: " a  b c", expect: held("a b c") },
	{ type: "choice", text: " a ", expect: held(" a ") },
	{ type: "text", text: "2026-02-30", expect: held("2026-02-30") },
	{ type: "untyped", text: "anything", expect: held("anything") },
];
