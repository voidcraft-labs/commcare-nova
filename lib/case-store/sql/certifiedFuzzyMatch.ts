import { type Expression, sql } from "kysely";

/** A hit on the analyzed exact-token branch is independent of fuzzy
 * expansion. The native term query requires a two-character prefix. In
 * every other case membership can depend on which 100 terms Lucene rewrote. */
export function certifiedFuzzyMatch(
	property: Expression<unknown>,
	needle: Expression<unknown>,
) {
	const value = sql`(${property})::text collate "C"`;
	const query = sql`(${needle})::text collate "C"`;
	const tokens = sql`regexp_split_to_array(lower(${value}), ' +')`;
	return sql<boolean | null>`case
		when coalesce(${query}, '') = '' then coalesce(${value}, '') = ''
		when coalesce(${value}, '') = '' then false
		when ${value} !~ '^[A-Za-z0-9 ]+$' or ${query} !~ '^[A-Za-z0-9 ]+$'
			or ${value} ~ '[A-Za-z0-9]{255}[A-Za-z0-9]' or ${query} ~ '[A-Za-z0-9]{255}[A-Za-z0-9]' then null
		when array_remove(${tokens}, '') && array_remove(regexp_split_to_array(lower(${query}), ' +'), '') then true
		when not exists(select 1 from unnest(${tokens}) as token where token <> '' and left(token,2) = left(lower(${query}),2)) then false
		else null end`;
}
