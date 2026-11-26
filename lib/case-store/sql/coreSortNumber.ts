import { type AliasableExpression, type RawBuilder, sql } from "kysely";
import { javaWallInstant } from "./javaZone";
import { resolveViewerTimeZone } from "./viewerTimeZone";

/** Decimal text accepted by Core's FunctionUtils.toNumeric after Java String.trim. */
export const PLAIN_DECIMAL_PATTERN = String.raw`^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$`;
export const JAVA_TRIMMED_CHARACTERS = Array.from({ length: 32 }, (_, index) =>
	String.fromCharCode(index + 1),
).join("");

/** Numeric key returned by Core's EntitySorter. Two SQL terms preserve Java's
 * ordering of negative and positive zero. PostgreSQL orders NaN after Infinity,
 * as Double.compare does, and checks casts before evaluating malformed input. */
export function coreSortNumber(
	value: AliasableExpression<unknown>,
	comparison: "integer" | "decimal",
	viewerTimeZone: string | undefined,
): readonly [RawBuilder<unknown>, RawBuilder<unknown>] {
	const text = sql<string>`btrim((${value})::text, ${JAVA_TRIMMED_CHARACTERS})`;
	const zone = resolveViewerTimeZone(viewerTimeZone);
	// Calendar reads year, month and day separately. Force the ISO order even when
	// the source did not pad them. Java split discards trailing empty dash segments.
	const part = (i: number) =>
		sql<string>`coalesce(nullif(ltrim(split_part(${text}, '-', ${i}), '0'), ''), '0')`;
	const year = part(1);
	const date = sql<string>`concat(lpad(${year}, greatest(length(${year}), 4), '0'), '-', ${part(2)}, '-', ${part(3)})`;
	const day = sql<unknown>`(${date})::date`;
	const historicalDay = sql<unknown>`(case when ${day} < date '1582-10-15'
        then ${day} + (floor((extract(year from ${day}) - (extract(month from ${day}) <= 2)::integer) / 100)
                        - floor((extract(year from ${day}) - (extract(month from ${day}) <= 2)::integer) / 400) - 2)::integer
        else ${day} end)`;
	const midnight = javaWallInstant(zone, sql`(${historicalDay})::timestamp`);
	const epoch = javaWallInstant(zone, sql`timestamp '1970-01-01'`);
	const days = sql<unknown>`floor(extract(epoch from (${midnight} - ${epoch})) / 86400 + 0.5)`;
	const parsed = sql<unknown>`(case
        when ${text} ~ ${PLAIN_DECIMAL_PATTERN} then case
            when pg_input_is_valid(${text}, 'double precision') then (${text})::double precision
            when split_part(${text}, '.', 1) ~ '[1-9]' then
                case when left(${text}, 1) = '-' then '-Infinity'::float8 else 'Infinity'::float8 end
            else 0::float8 end
        when ${text} ~ '^[0-9]+-[0-9]+-[0-9]+-*$' and pg_input_is_valid(${date}, 'timestamp')
            then (${days})::float8
        else 'NaN'::float8 end)`;
	const numericKey = comparison === "integer" ? sql`trunc(${parsed})` : parsed;
	const positiveZero = sql`(case when ${numericKey} = 0 then left(${text}, 1) <> '-' else false end)`;
	return [numericKey, positiveZero];
}
