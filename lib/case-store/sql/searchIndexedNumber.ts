import { type Expression, sql } from "kysely";

// HQ's property `.numeric` multifield is an Elasticsearch double with
// ignore_malformed (`es/mappings/case_search_mapping.py`), which reads a
// string with Java's `Double.parseDouble` and keeps only a finite value.
// Java trims every leading and trailing character up to U+0020 and also reads
// a type suffix, a hexadecimal significand, NaN and Infinity. Postgres reads
// the plain decimal spelling the same way; the other spellings, and a
// decimal Postgres cannot hold, are left to the index.
const JAVA_DOUBLE_TRIM = Array.from({ length: 32 }, (_, index) =>
	String.fromCharCode(index + 1),
).join("");
const DECIMAL_MANTISSA = "([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?";
const DECIMAL_NUMBER = `^[+-]?${DECIMAL_MANTISSA}$`;
const OTHER_JAVA_NUMBER = `^[+-]?(${DECIMAL_MANTISSA}[dDfF]|0[xX][0-9a-fA-F.]+[pP][+-]?[0-9]+[dDfF]?|NaN|Infinity)$`;

export function indexedSearchNumber(value: Expression<unknown>) {
	const trimmed = sql<string>`btrim((${value})::text, ${JAVA_DOUBLE_TRIM})`;
	const decimal = sql<boolean>`${trimmed} collate "C" ~ ${DECIMAL_NUMBER}`;
	const valid = sql<boolean>`pg_input_is_valid(${trimmed}, 'double precision')`;
	const number = sql<number>`case when ${decimal} and ${valid} then (${trimmed})::double precision end`;
	const uncertain = sql<boolean>`coalesce((${decimal} and not ${valid}) or ${trimmed} collate "C" ~ ${OTHER_JAVA_NUMBER}, false)`;
	return { trimmed, number, uncertain };
}
