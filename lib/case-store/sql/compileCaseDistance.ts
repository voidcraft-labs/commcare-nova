import { type AliasableExpression, sql } from "kysely";
import { JAVA_TRIMMED_CHARACTERS } from "./coreSortNumber";

// GeoPointData.cast parses each component with Double.parseDouble. PostgreSQL
// accepts the decimal and hexadecimal significands, but also accepts words
// Java rejects and rejects the type suffixes Java accepts.
const JAVA_FINITE = String.raw`^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX](?:[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]*)?|\.[0-9A-Fa-f]+)[pP][+-]?[0-9]+)[fFdD]?$`;

// Keep this failure independent of the case contents. Including any part of
// the value in a failing cast would send it back in PostgreSQL's error text.
const INVALID_COORDINATES = "nova_invalid_case_location";
export function isInvalidCaseLocationError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "22P02" &&
		error.message.endsWith(`"${INVALID_COORDINATES}"`)
	);
}

/** A valid significand whose conversion PostgreSQL calls out of range is
 * either too small or too large. The position of its first nonzero digit and
 * the written exponent distinguish the two. Decimal digits contribute one
 * decimal power each and hexadecimal digits four binary powers each. */
const rangeValue = sql`(
	select case when exponent + places * radix > 0 then 'Infinity'::float8 else 0::float8 end
		* case when left(number, 1) = '-' then -1 else 1 end
	from (select regexp_split_to_array(regexp_replace(ltrim(number, '+-'), '^0[xX]', ''),
			case when hexadecimal then '[pP]' else '[eE]' end) as parts,
			case when hexadecimal then 4 else 1 end as radix) as digits
	cross join lateral (select split_part(parts[1], '.', 1) as whole,
			replace(parts[1], '.', '') as significand,
			ltrim(ltrim(coalesce(parts[2], '0'), '+-'), '0') as exponent_digits) as magnitude
	cross join lateral (select length(whole)::bigint - length(significand)
			+ length(ltrim(significand, '0')) - 1 as places,
			case when length(exponent_digits) > 10 then 100000000000::bigint
				else coalesce(nullif(exponent_digits, ''), '0')::bigint end
			* case when left(parts[2], 1) = '-' then -1 else 1 end as exponent) as powers
)`;

/** HQ's distance sort sentinel and Core's GeoPointUtils haversine, in whole
 * metres. Read the original device value, including related-case reads.
 * The worker position is one bound parameter and travels only with this read. */
export function compileCaseDistance(
	value: AliasableExpression<unknown>,
	viewerLocation: string | null | undefined,
) {
	if (!viewerLocation)
		return sql<string>`(case when coalesce((${value})::text, '') = '' then '2147483647' else '-1' end)`;

	// The complete array is parsed even where a component is altitude or
	// accuracy. CommCare's DataUtil splits only runs of spaces, and a leading
	// space leaves an empty component. Only trailing spaces are discarded.
	const point = sql`array(
		select case
			when spelling in ('NaN', '+NaN', '-NaN') then 'NaN'::float8
			when spelling in ('Infinity', '+Infinity') then 'Infinity'::float8
			when spelling = '-Infinity' then '-Infinity'::float8
			when spelling !~ ${JAVA_FINITE} then (${INVALID_COORDINATES}::text || left(spelling, 0))::float8
			when pg_input_is_valid(number, 'double precision') then number::float8
			else ${rangeValue}
		end
		from unnest(regexp_split_to_array(rtrim(raw, ' '), ' +')) with ordinality as component(token, position)
		cross join lateral (select btrim(token, ${JAVA_TRIMMED_CHARACTERS}) as spelling) as trimmed
		cross join lateral (select rtrim(spelling, 'fFdD') as number, ltrim(spelling, '+-') as unsigned) as lexical
		cross join lateral (select unsigned ~ '^0[xX]' as hexadecimal) as base
		order by position
	)`;
	// The server obtained the worker's fix from validated coordinates. Core's
	// Math functions return NaN for nonfinite arguments or a square root outside
	// asin's domain, where PostgreSQL would throw and lose the whole list.
	const h = sql`power(sin((latitude - fix_latitude) / 2), 2)
		+ power(sin(delta_longitude / 2), 2) * cos(latitude) * cos(fix_latitude)`;
	return sql<string>`(select case when coalesce(raw, '') = '' then '2147483647' else
		(select case
			when cardinality(coordinates) not between 2 and 4 then
				(${INVALID_COORDINATES}::text || left(raw, 0))::float8::text
			when not (abs(coordinates[1]) < 'Infinity'::float8 and abs(coordinates[2]) < 'Infinity'::float8)
				then 'NaN'
			else (select case when hav >= 0 and sqrt(greatest(hav, 0)) <= 1
				then floor(6371009 * (2 * asin(sqrt(hav))) + 0.5)::bigint::text else 'NaN' end
				from (select ${h} as hav) as distance)
		end
		from (select ${point} as coordinates) as parsed
		cross join lateral (select radians(coordinates[1]) as latitude, radians(fix[1]) as fix_latitude,
			radians(coordinates[2]) - radians(fix[2]) as delta_longitude) as angles)
		end from (select (${value})::text as raw, regexp_split_to_array(${viewerLocation}::text, ' +')::float8[] as fix) as source)`;
}
