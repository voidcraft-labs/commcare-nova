import { type Expression, sql } from "kysely";

// HQ's property-date multifield uses corehq/pillows/core.py::DATE_FORMATS_ARR.
// The ISO formats below have an unambiguous PostgreSQL equivalent. Two
// legacy patterns (minute/day/year and offset followed by a literal Z) need
// the index itself. The loose test makes their possible membership explicit.
const day = "[0-9]{4}-[0-9]{2}-[0-9]{2}";
const time = "([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";
const offset = "[+-](0[0-9]|1[0-4]):?[0-5][0-9]";
const fractionOffset = "[.][0-9]{3}[+-](0[0-9]|1[0-4]):[0-5][0-9]";
const iso = `^${day}(T${time}([.][0-9]{6}Z?|${fractionOffset}|Z|${offset})?| ${time}([.][0-9]{6})?)?$`;

export function indexedSearchDate(value: Expression<unknown>) {
	const supported = sql<boolean>`${value} collate "C" ~ ${iso}`;
	const instant = sql<Date>`case when ${supported} and pg_input_is_valid(${value}, 'timestamptz')
		then date_trunc('milliseconds', case when ${value} ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$'
			then (${value})::timestamptz else timezone('UTC',(${value})::timestamp) end) end`;
	const uncertain = sql<boolean>`coalesce(not ${supported} and (${value} collate "C" ~ '^[0-9]{2}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
		or ${value} collate "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'),false)`;
	return { instant, uncertain };
}
