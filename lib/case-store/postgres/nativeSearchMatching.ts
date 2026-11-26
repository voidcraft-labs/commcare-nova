import { type RawBuilder, sql } from "kysely";
import type { CaseSearchCriterion } from "../searchRequest";
import type { PredicateCompileContext } from "../sql";
import {
	certifiedFuzzyMatch,
	type FuzzyScope,
} from "../sql/certifiedFuzzyMatch";
import {
	compileRelationPath,
	relationPathContextFrom,
} from "../sql/compileRelationPath";
import { indexedSearchDate } from "../sql/searchIndexedDate";

type Truth = RawBuilder<boolean | null>;

/** case_properties.value is whitespace-analyzed text, and its exact subfield
 * is a case-sensitive keyword (ignore_above 8191 UTF-16 code units). */
function propertyMatches(
	value: RawBuilder<unknown>,
	values: readonly string[],
	fuzzy: boolean,
	scope: FuzzyScope,
): Truth {
	const blank = values.includes("");
	const terms = values.filter((v) => v !== "");
	const missing = sql<boolean>`coalesce((${value})::text, '') = ''`;
	if (terms.length === 0) return blank ? missing : sql`false`;
	if (!fuzzy)
		return sql`(coalesce(${value} = any(${terms.filter((v) => v.length <= 8191)}::text[]), false) or ${blank} and ${missing})`;
	const needle = terms[0];
	if (needle === undefined) return missing;
	return sql`(${certifiedFuzzyMatch(value, sql.val(needle), scope)} or ${blank} and ${missing})`;
}

/** All-blank multivalue criteria ask whether the original indexed key is
 * missing or empty. The index adds metadata under these literal keys. */
export function missingNativeProperty(key: string): Truth {
	switch (key) {
		case "@case_id":
		case "@case_type":
		case "@status":
		case "case_name":
		case "name":
			return sql`false`;
		case "@owner_id":
			return sql`coalesce(c.owner_id,'') = ''`;
		case "external_id":
			return sql`coalesce(c.external_id,'') = ''`;
		case "date_opened":
			return sql`c.opened_on is null`;
		case "closed_on":
			return sql`c.closed_on is null`;
		case "last_modified":
			return sql`c.modified_on is null`;
		default:
			return sql`coalesce(c.properties ->> ${key}, '') = ''`;
	}
}

export function nativeSearchTruth(
	criterion: Extract<CaseSearchCriterion, { kind: "native" }>,
	ctx: PredicateCompileContext,
): Truth {
	const { target, values } = criterion.parameter;
	const read = (source: string, column: string) =>
		sql.ref(`${source}.${column}`);

	switch (target.kind) {
		case "record-id":
			return sql`c.case_id = any(${values}::text[])`;
		case "excluded-owners": {
			// HQ ignores a blank value, then splits the value on each space
			// (`SearchCriteria.value_as_list`) and keeps every case whose owner
			// is none of them (`case_search.blacklist_owner_id`).
			const excluded = values.flatMap((value) =>
				value === "" ? [] : value.split(" "),
			);
			return sql`not coalesce(c.owner_id = any(${excluded}::text[]),false)`;
		}
		case "owner":
			return values.length === 1 && values[0] === ""
				? sql`true`
				: sql`coalesce(c.owner_id = any(${values}::text[]),false)`;
		case "project-space":
			return values.length === 1 && values[0] === ""
				? sql`true`
				: criterion.projectSpace === undefined
					? sql`null::boolean`
					: sql`${values.includes(criterion.projectSpace)}::boolean`;

		case "link":
			throw new Error("A case link needs its history-aware search criterion.");
		case "attribute":
		case "record-name":
		case "property": {
			const sourceValue = (source: string) => {
				if (target.kind === "record-name")
					return sql`${read(source, "case_name")}`;
				if (target.kind === "attribute") {
					const column = {
						id: "case_id",
						type: "case_type",
						owner: "owner_id",
						status: "status",
					}[target.attribute];
					return sql`${read(source, column)}`;
				}
				switch (target.property) {
					case "case_name":
						return sql`${read(source, "case_name")}`;
					case "closed_on":
					case "date_opened":
					case "last_modified": {
						// CommCareCase.to_json uses DRF's six fractional digits
						// (HQ settings.REST_FRAMEWORK.DATETIME_FORMAT).
						const column =
							target.property === "date_opened"
								? "opened_on"
								: target.property === "last_modified"
									? "modified_on"
									: "closed_on";
						return sql`to_char(timezone('UTC', ${read(source, column)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
					}
					case "external_id":
						return sql`${read(source, "external_id")}`;
					default:
						return sql`${read(source, "properties")} ->> ${target.property}`;
				}
			};
			if (!target.ancestors)
				return propertyMatches(sourceValue("c"), values, criterion.fuzzy, ctx);
			const [first, ...rest] = target.ancestors;
			// Type annotations resolve the author's property. HQ follows the
			// named links themselves, including links retained in old data.
			const path = compileRelationPath(
				{
					kind: "ancestor",
					via: [
						{ identifier: first.identifier },
						...rest.map(({ identifier }) => ({ identifier })),
					],
				},
				relationPathContextFrom(ctx),
			);
			if (path.kind !== "joined")
				throw new Error("An ancestor filter requires a related record.");
			const match =
				target.kind === "attribute" &&
				target.attribute === "status" &&
				!criterion.fuzzy &&
				values.length === 1
					? sql<boolean>`${values[0] !== ""} and ${read(path.leafAlias, "status")} = ${values[0] === "closed" ? "closed" : "open"}`
					: propertyMatches(
							sourceValue(path.leafAlias),
							values,
							criterion.fuzzy,
							ctx,
						);
			// The native ancestor query looks up matching parents and then follows
			// their reverse links. A record with no such ancestor never qualifies.
			return sql`(select case when bool_or(accepted) then true when bool_or(accepted is null) then null else false end
				from (select ${match} as accepted from ${path.buildLeafSubquery()}
					where ${read(path.leafAlias, "anchor_case_id")} = ${read(ctx.anchorAlias, "case_id")}) as parents)`;
		}
	}
}

/** HQ's .date multifield reads the date spellings in corehq/pillows/core.py.
 * Date-only range ends include the complete UTC day. Unknown legacy shapes
 * cannot certify membership; plainly non-date text has no indexed date. */
export function nativeRangeTruth(
	criterion: Extract<CaseSearchCriterion, { kind: "native-range" }>,
	ctx: PredicateCompileContext,
): Truth {
	const { key, field, start, end, blankTarget } = criterion;
	let value: RawBuilder<unknown>;
	switch (key) {
		case "case_name":
		case "name":
			value = sql`c.case_name`;
			break;
		case "closed_on":
		case "date_opened":
		case "last_modified": {
			const column =
				key === "date_opened"
					? "opened_on"
					: key === "last_modified"
						? "modified_on"
						: "closed_on";
			value = sql`to_char(timezone('UTC', ${sql.ref(`c.${column}`)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
			break;
		}
		case "external_id":
			value = sql`c.external_id`;
			break;
		default:
			value = sql`c.properties ->> ${key}`;
	}
	const indexed = indexedSearchDate(value);
	const within = sql<
		boolean | null
	>`case when ${indexed.uncertain} then null else coalesce(
		${indexed.instant} >= timezone('UTC', ${start}::date::timestamp)
		and ${indexed.instant} < timezone('UTC', (${end}::date + 1)::timestamp), false) end`;
	if (!blankTarget) return within;
	const missing =
		"ancestors" in blankTarget && blankTarget.ancestors
			? nativeSearchTruth(
					{
						kind: "native",
						parameter: { key, field, target: blankTarget, values: [""] },
						fuzzy: false,
					},
					ctx,
				)
			: missingNativeProperty(key);
	return sql`(${within} or ${missing})`;
}

/** Raw text indexed under the property key before any numeric, date or exact projection. */
export function nativeSearchPropertyText(key: string) {
	switch (key) {
		case "@case_id":
			return sql`c.case_id`;
		case "@case_type":
			return sql`c.case_type`;
		case "@owner_id":
			return sql`c.owner_id`;
		case "@status":
			return sql`c.status`;
		case "case_name":
		case "name":
			return sql`c.case_name`;
		case "closed_on":
		case "date_opened":
		case "last_modified": {
			const column =
				key === "date_opened"
					? "opened_on"
					: key === "last_modified"
						? "modified_on"
						: "closed_on";
			return sql`to_char(timezone('UTC', ${sql.ref(`c.${column}`)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
		}
		case "external_id":
			return sql`coalesce(c.external_id,'')`;
		default:
			return sql`c.properties ->> ${key}`;
	}
}
