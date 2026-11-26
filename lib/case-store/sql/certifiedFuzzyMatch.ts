import { type Expression, type RawBuilder, sql } from "kysely";

// CommCare HQ's similar-match search (`apps/es/case_search.py::
// case_property_query(fuzzy=True)`) ORs two Elasticsearch queries on the
// searched property's `case_properties.value`, whose analyzer is the case
// search index's default (`es/index/analysis.py::PHONETIC_ANALYSIS`):
// Lucene's whitespace tokenizer (`Character.isWhitespace`, a token cut at
// every 255 UTF-16 units) and lowercase filter (`Character.toLowerCase`,
// Unicode simple case mapping per code point). No accent folding.
//
//  1. `match` with fuzziness 0: the query analyzed the same way, any query
//     token equal to any stored token.
//  2. `fuzzy` (`es/queries.py::fuzzy`): the whole query lowercased by Python
//     (`str.lower`, full case mapping) as ONE term, AUTO fuzziness by its code
//     points (0 below 3, 1 below 6, else 2: ES 6.8 `Fuzziness.asDistance`),
//     a two code point prefix that must match exactly, Levenshtein edits
//     without transpositions (`FuzzyQueryBuilder.DEFAULT_TRANSPOSITIONS`), and
//     at most 100 expansions (`TopTermsBlendedFreqScoringRewrite`): the 100
//     index terms closest to the query, from every value of every case.
//
// The expansion limit is the one part the searched row cannot decide. A
// stored term within reach of the query is certainly kept when it is the
// query itself, or when at most 100 terms are within reach across the
// Project's records (Preview's equivalent of the project space's index).
// Past 100 which terms survive depends on how the index holds its words, so
// the row's similar match stays unknown. A row with no term within reach is
// certainly no similar match, whatever the index holds.

/** Lucene's `WhitespaceTokenizer`: `Character.isWhitespace`, which leaves
 * out the no-break spaces U+00A0, U+2007 and U+202F. */
const JAVA_WHITESPACE =
	"\t\n\u000B\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000";
const TOKEN_BREAK = `[${JAVA_WHITESPACE}]+`;
const SUPPLEMENTARY = `[${String.fromCodePoint(0x10000)}-${String.fromCodePoint(0x10ffff)}]`;

/** Letters whose simple lowercase mapping arrived after Unicode 11 (Java 12,
 * the oldest runtime of HQ's Elasticsearch 6.8 image): 12.0 to 16.0 added
 * case pairs only in these blocks. Postgres's `pg_c_utf8` (Unicode 16), the
 * index's Java and HQ's Python can lowercase them differently. */
const UNSTABLE_CASE = `[\u1C89\u1C8A\u2C2F\u2C5F\uA7BA-\uA7FF${String.fromCodePoint(0x10570)}-${String.fromCodePoint(0x105bf)}${String.fromCodePoint(0x10d50)}-${String.fromCodePoint(0x10d8f)}]`;

const CAPITAL_SIGMA = "\u03A3";
const SIGMA = "\u03C3";
const FINAL_SIGMA = "\u03C2";

/** The expansion limit of HQ's fuzzy query. */
export const FUZZY_MAX_EXPANSIONS = 100;

type Text = Expression<unknown>;

/** Unicode simple case mapping, as Java's `Character.toLowerCase(int)`. */
function javaLower(text: Text) {
	return sql<string>`lower((${text})::text collate "pg_c_utf8")`;
}

/** Python's `str.lower` where it differs from simple mapping without
 * context: U+0130 lowers to "i̇". Final sigma, the other difference, keeps
 * a query holding Σ undecided wherever a stored term could be in reach. */
function pythonLower(text: Text) {
	return sql<string>`lower(replace((${text})::text, ${"\u0130"}, ${"i\u0307"}) collate "pg_c_utf8")`;
}

/** The tokens the index holds for a text: whitespace runs split it, each
 * piece lowercased and cut every 255 code points. A piece with a
 * supplementary character over 127 code points is cut by UTF-16 units, which
 * `undecidableToken` keeps out of every certain answer. */
function indexTokens(text: Text) {
	return sql<string[]>`array(select substr(piece, 1 + 255 * cut, 255)
		from unnest(regexp_split_to_array(${javaLower(text)}, ${TOKEN_BREAK})) as piece
		cross join lateral generate_series(0, greatest(char_length(piece) - 1, 0) / 255) as cut
		where piece <> '')`;
}

function undecidableToken(token: Text) {
	return sql<boolean>`(char_length(${token}) > 127 and ${token} ~ ${SUPPLEMENTARY})`;
}

/** The AUTO edit distance of the fuzzy term. */
function editsFor(term: Text) {
	return sql<number>`(case when char_length(${term}) < 3 then 0 when char_length(${term}) < 6 then 1 else 2 end)`;
}

/** Whether an index token is within reach of the fuzzy term. The caller
 * keeps `char_length(term)` at most 255 (fuzzystrmatch's own limit). */
function withinReach(token: Text, term: Text, fold: boolean) {
	const f = (text: Text) =>
		fold
			? sql<string>`translate(${text}, ${FINAL_SIGMA}, ${SIGMA})`
			: sql<string>`${text}`;
	const edits = editsFor(term);
	return sql<boolean>`(case
		when left(${f(token)}, 2) <> left(${f(term)}, 2) then false
		when abs(char_length(${token}) - char_length(${term})) > ${edits} then false
		when char_length(${term}) > 255 then false
		else levenshtein(${f(token)}, ${f(term)}) <= ${edits} end)`;
}

/** The fuzzy term of a query, Python-lowered. */
export function fuzzyTerm(needle: Text) {
	return pythonLower(needle);
}

/** Every value HQ's case search index holds for a record
 * (`pillows/case_search.py::_get_case_properties`): the indexed metadata of
 * `case_search/const.py::INDEXED_METADATA_BY_KEY` and each case property. */
function indexedValues(alias: string) {
	const column = (name: string) => sql.ref(`${alias}.${name}`);
	const stamp = (name: string) =>
		sql`to_char(timezone('UTC', ${column(name)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
	return sql<
		string[]
	>`(array[${column("case_id")}, ${column("case_type")}, ${column("owner_id")},
		case when ${column("status")} = 'closed' then 'closed' else 'open' end,
		${column("case_name")}, ${column("external_id")}, ${stamp("opened_on")}, ${stamp("closed_on")}, ${stamp("modified_on")}]::text[]
		|| coalesce(array(select entry.value from jsonb_each_text(${column("properties")}) as entry), '{}'::text[]))`;
}

export interface FuzzyScope {
	readonly appId: string;
	readonly projectId: string;
}

/** How many distinct index terms across the Project's records of the app
 * are within reach of the fuzzy term. A token Preview cannot cut or lowercase
 * as the index does counts as past the limit when it could hold the prefix. */
export function fuzzyTermsWithinReach(needle: Text, scope: FuzzyScope) {
	const term = fuzzyTerm(needle);
	return sql<number>`(select count(distinct vocabulary_token) + case when bool_or(vocabulary_unclear) then ${FUZZY_MAX_EXPANSIONS + 1} else 0 end
		from (select vocabulary_token,
				${undecidableToken(sql.ref("vocabulary_token"))} and strpos(vocabulary_token, left(${term}, 2)) > 0
				or vocabulary_token ~ ${UNSTABLE_CASE} and abs(char_length(vocabulary_token) - char_length(${term})) <= ${editsFor(term)} as vocabulary_unclear
			from cases as vocabulary_case
			cross join lateral unnest(${indexedValues("vocabulary_case")}) as vocabulary_value(value)
			cross join lateral unnest(${indexTokens(sql.ref("vocabulary_value.value"))}) as vocabulary_tokens(vocabulary_token)
			where vocabulary_case.app_id = ${scope.appId} and vocabulary_case.project_id = ${scope.projectId}
				and vocabulary_value.value is not null) as vocabulary
		where vocabulary_unclear or ${withinReach(sql.ref("vocabulary_token"), term, false)})`;
}

/** Whether the fuzzy term reaches past HQ's expansion limit in the Project. */
export function fuzzyExpansionExceeded(needle: Text, scope: FuzzyScope) {
	return sql<boolean>`(char_length(${fuzzyTerm(needle)}) >= 3 and ${fuzzyTermsWithinReach(needle, scope)} > ${FUZZY_MAX_EXPANSIONS})`;
}

/** HQ's similar match of one stored value against one query: true or false
 * where the rows decide it, null where only the project space's index can. */
export function certifiedFuzzyMatch(
	property: Text,
	needle: Text,
	scope: FuzzyScope,
): RawBuilder<boolean | null> {
	const value = sql`(${property})::text`;
	const query = sql`(${needle})::text`;
	const stored = indexTokens(value);
	const asked = indexTokens(query);
	const term = fuzzyTerm(query);
	const reach = (fold: boolean) =>
		sql<boolean>`exists(select 1 from unnest(${stored}) as stored_token
			where ${withinReach(sql.ref("stored_token"), term, fold)})`;
	return sql<boolean | null>`case
		when coalesce(${query}, '') = '' then coalesce(${value}, '') = ''
		when coalesce(${value}, '') = '' then false
		when exists(select 1 from unnest(${stored}) as shared_token
			where shared_token = any(${asked}) and shared_token !~ ${UNSTABLE_CASE}
				and not ${undecidableToken(sql.ref("shared_token"))}) then true
		when ${value} ~ ${UNSTABLE_CASE} or ${query} ~ ${UNSTABLE_CASE} then null
		when exists(select 1 from unnest(${stored} || ${asked}) as long_token
			where ${undecidableToken(sql.ref("long_token"))}) then null
		when char_length(${term}) > 257 then false
		when char_length(${term}) > 255 then null
		when not ${reach(true)} then false
		when strpos(${query}, ${CAPITAL_SIGMA}) > 0 then null
		when ${term} = any(${stored}) then true
		when not ${reach(false)} then false
		when ${fuzzyTermsWithinReach(query, scope)} <= ${FUZZY_MAX_EXPANSIONS} then true
		else null end`;
}

/** Whether a query or stored value holds text Preview cannot read as the
 * index and HQ's Python do. */
export function fuzzyTextUnclear(property: Text, needle: Text) {
	const value = sql`(${property})::text`;
	const query = sql`(${needle})::text`;
	return sql<boolean>`coalesce(${value} ~ ${UNSTABLE_CASE} or ${query} ~ ${UNSTABLE_CASE}
		or strpos(${query}, ${CAPITAL_SIGMA}) > 0 or char_length(${fuzzyTerm(query)}) between 256 and 257
		or exists(select 1 from unnest(${indexTokens(value)} || ${indexTokens(query)}) as long_token
			where ${undecidableToken(sql.ref("long_token"))}), false)`;
}
