/**
 * The interval column's shown text, as a sort key.
 *
 * A case list orders a shown interval column by the text it shows on every
 * path (`lib/domain/caseListOrder.ts`, rules 3 and 6), and an unsorted list
 * whose first field is an interval column is ordered by that text too. The
 * text is a date difference, which `arith` refuses as a `DomainExpression`
 * (`lib/domain/expression/typeChecker.ts::checkExpression`), so this one key
 * has its own compiler entry, built from typed-builder calls inside the
 * compiler package, which stays the only evaluator.
 *
 * It spells the branches the device evaluates
 * (`lib/commcare/suite/case-list/columns.ts::intervalAlwaysXpath` and
 * `intervalFlagXpath`) and Preview shows
 * (`lib/preview/columnDisplay.ts::formatIntervalForPreview`):
 *
 *   - `v` is the property's stored text, trimmed, read as text whatever its
 *     declared type, so a malformed stored value never fails the query. A
 *     standard property is the text its reading holds
 *     (`compileReadingText`): under `results`, `last_modified` is HQ's
 *     `json_format_datetime` text, as the column shows it.
 *   - `d` is its calendar day as Core's `date()` gives it
 *     (`compileCoreDateDay`): Core reads the authored day and keeps it, and
 *     only an authored offset's clock moves into the viewer's zone.
 *   - `today` is the viewer's date (`compileToday`).
 *   - The guard comes before any cast: a value that is no date yields its
 *     raw text, as Preview shows it. A date is what Core's `date()` reads, a
 *     `year-month-day` of whole numbers, alone or followed by `T` and a time
 *     (`DateUtils.parseDateTime`), that Postgres also reads as an instant
 *     (`pg_input_is_valid`, Postgres 16 and later). The shape comes first
 *     because Postgres reads words Core does not: `infinity`, `-infinity`,
 *     `epoch`, `now`, `today`, `tomorrow` and `yesterday` are text on a
 *     device, and an infinite date would fail the query's date arithmetic.
 *
 * `always`: blank for a blank value, the raw text where unreadable, `text`
 * past the threshold, and otherwise the whole number of units, truncated
 * toward zero. `flag`: `text` for a blank value, the raw text where
 * unreadable, `text` past the threshold, and otherwise blank.
 */

import { type AliasableExpression, expressionBuilder } from "kysely";
import type { CaseType } from "@/lib/domain/blueprint";
import { prop, term } from "@/lib/domain/expression/builders";
import {
	compileReadingText,
	compileToday,
	type ExpressionCompileContext,
} from "./compileExpression";
import type { Database } from "./database";
import { javaLocalTimestamp, javaWallInstant } from "./javaZone";
import { resolveViewerTimeZone } from "./viewerTimeZone";

const eb = expressionBuilder<Database, keyof Database>();

/** The shape of a value Core's `date()` reads: a `year-month-day` of whole
 *  numbers, alone or before a `T` and a time. */
const CORE_DATE_SHAPE = "^[0-9]+-[0-9]+-[0-9]+(T|$)";

export interface IntervalTextKey {
	readonly caseType: string;
	readonly property: string;
	readonly display: "always" | "flag";
	/** The threshold in days: the authored count times `divisorDays`. */
	readonly thresholdDays: number;
	/** Days in one unit (`TIME_SINCE_UNIT_DAYS`). */
	readonly divisorDays: number;
	/** The column's text in the worker's language. */
	readonly text: string;
}

/** The schemas with one property read as text, so its stored value reaches
 *  the guard before any typed cast. */
function withTextRead(
	schemas: ReadonlyMap<string, CaseType>,
	caseType: string,
	property: string,
): ReadonlyMap<string, CaseType> {
	const type = schemas.get(caseType);
	if (type === undefined) return schemas;
	const next = new Map(schemas);
	next.set(caseType, {
		...type,
		properties: type.properties.map((candidate) =>
			candidate.name === property
				? { ...candidate, data_type: "text" as const }
				: candidate,
		),
	});
	return next;
}

/**
 * The calendar day Core's `date()` gives date text `v` (already guarded as
 * one) in the viewer's `zone`, as `today() - date(v)` counts it: Core's
 * `daysSinceEpoch` rounds the `Date` that `DateUtils.parseDateTime` returns to
 * its local day.
 *
 * `parseDateTime` keeps the authored `year-month-day` whatever the time says.
 * A time without an offset is a wall clock in the device's zone. A time with
 * one (`Z`, or a `+` or `-` after the `T`, `parseTimeAndStore`) is read as
 * its instant, and only that instant's local clock (hour, minute, second and
 * milliseconds) is copied back onto the authored day; the instant's own local
 * day is dropped. So `2026-10-22T02:30:00Z` is 22 October in Los Angeles,
 * where that instant falls on the 21st. The wall clock then resolves as
 * `java.util.Calendar` resolves it (`javaWallInstant`) and its day is taken
 * as `java.util.TimeZone` reads it (`javaLocalTimestamp`), as Preview's
 * `XPathDate.parse` does.
 */
function compileCoreDateDay(
	v: AliasableExpression<string>,
	zone: string,
): AliasableExpression<unknown> {
	const time = eb.fn<string>("split_part", [v, eb.val("T"), eb.val(2)]);
	const hasOffset = eb(time, "~", eb.val("(Z$|[-+])"));
	const authoredDay = eb.cast(
		eb.fn<string>("split_part", [v, eb.val("T"), eb.val(1)]),
		"date",
	);
	const localClock = eb.cast(
		javaLocalTimestamp(zone, eb.cast(v, "timestamptz")),
		"time",
	);
	const wallClock = eb
		.case()
		.when(hasOffset)
		.then(eb(authoredDay, "+", localClock))
		.else(eb.cast(v, "timestamp"))
		.end();
	return eb.cast(
		javaLocalTimestamp(zone, javaWallInstant(zone, wallClock)),
		"date",
	);
}

export function compileIntervalText(
	key: IntervalTextKey,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const zone = resolveViewerTimeZone(ctx.bindings.viewerTimeZone);
	const raw = compileReadingText(term(prop(key.caseType, key.property)), {
		...ctx,
		caseTypeSchemas: withTextRead(
			ctx.caseTypeSchemas,
			key.caseType,
			key.property,
		),
	});
	const v = eb.fn<string>("btrim", [eb.cast(raw, "text")]);
	const blank = eb.or([eb(v, "is", null), eb(v, "=", eb.val(""))]);
	const unreadable = eb.not(
		eb.and([
			eb(v, "~", eb.val(CORE_DATE_SHAPE)),
			eb.fn<boolean>("pg_input_is_valid", [v, eb.val("timestamptz")]),
		]),
	);
	const day = compileCoreDateDay(v, zone);
	const elapsed = eb(compileToday(ctx), "-", day);
	// The threshold can be fractional (a month is 30.4375 days), so it is
	// compared as a number, never an integer parameter.
	const pastThreshold = eb(
		eb.cast(elapsed, "numeric"),
		">",
		eb.cast(eb.val(String(key.thresholdDays)), "numeric"),
	);
	const text = eb.val(key.text);
	if (key.display === "flag") {
		return eb
			.case()
			.when(blank)
			.then(text)
			.when(unreadable)
			.then(v)
			.when(pastThreshold)
			.then(text)
			.else(eb.val(""))
			.end();
	}
	const units = eb.cast(
		eb.fn("trunc", [
			eb(
				eb.cast(elapsed, "numeric"),
				"/",
				eb.cast(eb.val(String(key.divisorDays)), "numeric"),
			),
		]),
		"text",
	);
	return eb
		.case()
		.when(blank)
		.then(eb.val(""))
		.when(unreadable)
		.then(v)
		.when(pastThreshold)
		.then(text)
		.else(units)
		.end();
}
