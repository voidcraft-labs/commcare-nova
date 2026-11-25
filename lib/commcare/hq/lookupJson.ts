import "server-only";

/**
 * The JSON carrier of a lookup table: CommCare HQ's REST resources for one
 * table's definition and its rows, written one request at a time.
 *
 * The workbook (`lookupTables.ts::uploadLookupTableWorkbook`) replaces whole
 * tables by tag and cannot carry everything a table holds: a table tagged
 * `types` aliases the workbook's own definition sheet
 * (`fixtures/upload/workbook.py::_FixtureWorkbook.get_data_sheet`), its
 * reader strips a cell's surrounding spaces and drops a numbered blank value
 * (`corehq/util/workbook_json/excel.py::IteratorJSONReader`), and one upload
 * takes at most 500,000 physical rows (`fixtures/upload/const.py`). The JSON
 * resources carry each of those exactly. They carry no index and no row
 * owner: `fixtures/resources/v0_1.py::LookupTableResource`'s schema admits a
 * field's name and properties only, so `TypeField(**field)` leaves
 * `is_indexed` false and a PUT of `fields` resets every index, and
 * `LookupTableItemResource` has no owner writer. Only a global table with no
 * index travels this way (`lib/commcare/lookup/carrier.ts`).
 *
 * Each function sends one request and answers one of three outcomes, the
 * distinction a journaled caller resumes from: `applied`, CommCare HQ
 * acknowledged the write; `not-applied`, it refused before the view could
 * write (`http.ts::writeMayHaveLanded`); `uncertain`, the write may have
 * landed and only a read of the exact resource can tell. Nothing here
 * retries a write.
 *
 * What CommCare HQ does with each, read in source:
 *
 *   * `LookupTableResource.obj_create` (POST `lookup_table/v1/`) refuses a
 *     tag the project space already has with a 400 before it saves, and
 *     `LookupTable.Meta.unique_together` holds `(domain, tag)`. The resource
 *     keeps `always_return_data` off, so the 201 carries no body, and its
 *     `resource_uri` reverses to "" under HQ's versioned URLs: the created
 *     table is found by its tag afterwards.
 *   * `LookupTableResource.obj_update` (PUT `lookup_table/v1/<id>/`) refuses a
 *     changed tag, and replaces `is_global`, `fields` and `item_attributes`
 *     where the body names them.
 *   * `v0_6.LookupTableItemResource` (`lookup_table_item/v2/`) is the row
 *     resource with `always_return_data`: a POST answers the saved row with
 *     its minted `id`. `obj_create` appends: it sets `sort_key` to the
 *     table's largest plus one, whatever the body says.
 *   * `obj_update` (PUT on the row's detail) hydrates every field from the
 *     body, `data_type_id` and `sort_key` included, and saves where `fields`
 *     or `item_attributes` is named; it answers a missing row 404 through
 *     `api/util.py::not_found`, so tastypie's `put_detail` never falls back
 *     to creating one.
 *   * `obj_delete` deletes the row of that id in the project space; it
 *     returns its `HttpAccepted` rather than raising it, so tastypie's
 *     `delete_detail` answers 204 (seen in `proof/hq/test_lookup_json.py`);
 *     a row that is not there is 404.
 */

import { recordFromEntries } from "@/lib/domain/records";
import { log } from "@/lib/logger";
import { HQ_LOOKUP_DETAIL_MAX_BYTES } from "./bounds";
import { withHqRequestDeadline } from "./deadline";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	type HqAnswer,
	isValidDomainSlug,
	logAndReturnError,
	readAnswerJson,
	sendHq,
	writeMayHaveLanded,
} from "./http";
import { isHqObject } from "./readCollection";

/** CommCare HQ's own id of a table or a row: a UUID's hex, no hyphens. */
const REMOTE_ID = /^[a-f0-9]{32}$/;
/** `LookupTableRow.sort_key` is a Postgres `integer`. */
const SORT_KEY_MIN = -2_147_483_648;
const SORT_KEY_MAX = 2_147_483_647;
/** One write's whole exchange, as the workbook upload's own deadline. */
const WRITE_DEADLINE_MS = 60_000;

/** A table's definition as the JSON resource takes it. */
export interface HqLookupJsonDefinition {
	readonly tag: string;
	readonly fields: readonly {
		readonly name: string;
		readonly properties: readonly string[];
	}[];
	readonly itemAttributes: readonly string[];
}

/** One row as the JSON row resource takes it: every field's ordered values. */
export interface HqLookupJsonRow {
	readonly fields: Readonly<
		Record<
			string,
			readonly {
				readonly value: string;
				readonly properties: Readonly<Record<string, string>>;
			}[]
		>
	>;
	readonly itemAttributes: Readonly<Record<string, string>>;
	/** The rank a PUT writes; a POST's is CommCare HQ's own, its largest plus one. */
	readonly sortKey: number;
}

/** What one write came to. */
export type HqLookupJsonWrite<T> =
	| { readonly kind: "applied"; readonly value: T }
	/** CommCare HQ refused before its view could write: nothing changed. */
	| { readonly kind: "not-applied"; readonly error: CommCareApiError }
	/** It may have landed. Only a read of the exact resource tells. */
	| { readonly kind: "uncertain"; readonly error: CommCareApiError };

function root(creds: CommCareCredentials, domain: string): string {
	return `${baseUrl(creds)}/a/${domain}/api`;
}

function validSortKey(value: number): boolean {
	return (
		Number.isSafeInteger(value) &&
		value >= SORT_KEY_MIN &&
		value <= SORT_KEY_MAX
	);
}

/** The body a table create or update sends (`LookupTableResource`). */
export function lookupTableJsonBody(
	definition: HqLookupJsonDefinition,
): Record<string, unknown> {
	return {
		tag: definition.tag,
		is_global: true,
		fields: definition.fields.map((field) => ({
			field_name: field.name,
			properties: [...field.properties],
		})),
		item_attributes: [...definition.itemAttributes],
	};
}

/** The body a row create or update sends (`v0_6.LookupTableItemResource`). */
export function lookupRowJsonBody(
	tableId: string,
	row: HqLookupJsonRow,
): Record<string, unknown> {
	return {
		data_type_id: tableId,
		// A field or a detail may be named `__proto__` or `constructor`: each is
		// an own entry of a record with no prototype, which JSON writes as named.
		fields: recordFromEntries(
			Object.entries(row.fields).map(([name, values]) => [
				name,
				{
					field_list: values.map((item) => ({
						field_value: item.value,
						properties: item.properties,
					})),
				},
			]),
		),
		item_attributes: row.itemAttributes,
		sort_key: row.sortKey,
	};
}

const INVALID: HqLookupJsonWrite<never> = {
	kind: "not-applied",
	error: HQ_MALFORMED_ANSWER,
};

/**
 * Send one write and classify what came back. `accept` answers an
 * acknowledged status; a body it cannot read as the acknowledgement it
 * expects is `uncertain`, since the write may still have landed.
 */
async function write<T>(
	creds: CommCareCredentials,
	context: string,
	url: string,
	method: "POST" | "PUT" | "DELETE",
	body: Record<string, unknown> | null,
	accept: (answer: HqAnswer) => Promise<T | null>,
	cancel: AbortSignal | undefined,
): Promise<HqLookupJsonWrite<T>> {
	return withHqRequestDeadline(
		async (signal) => {
			let answer: HqAnswer;
			try {
				answer = await sendHq(creds, url, {
					method,
					...(body === null
						? {}
						: {
								contentType: "application/json",
								body: JSON.stringify(body),
							}),
					accept: "application/json",
					signal,
				});
			} catch (error) {
				log.warn(`[commcare] ${context} unanswered`, {
					error: error instanceof Error ? error.name : "unknown",
				});
				return {
					kind: "uncertain",
					error: {
						success: false,
						status: 503,
						cause: signal.aborted ? "timeout" : "network",
					},
				};
			}
			if (!answer.ok) {
				const error = await logAndReturnError(`${context} refused`, answer);
				return writeMayHaveLanded(error.status, error.edgeRefusal)
					? { kind: "uncertain", error }
					: { kind: "not-applied", error };
			}
			const value = await accept(answer);
			if (value === null) {
				log.error(
					`[commcare] ${context} acknowledgement unreadable`,
					undefined,
					{
						status: answer.status,
					},
				);
				return {
					kind: "uncertain",
					error: { ...HQ_MALFORMED_ANSWER },
				};
			}
			return { kind: "applied", value };
		},
		WRITE_DEADLINE_MS,
		cancel,
	);
}

async function emptyAcknowledgement(answer: HqAnswer): Promise<true | null> {
	await answer.discard();
	return true;
}

/**
 * Create a global table at a tag the project space does not hold. The 201
 * names no id: the caller finds the table by its tag, which CommCare HQ
 * holds unique in a project space.
 */
export async function createHqLookupTableJson(
	creds: CommCareCredentials,
	domain: string,
	definition: HqLookupJsonDefinition,
	cancel?: AbortSignal,
): Promise<HqLookupJsonWrite<true>> {
	if (!isValidDomainSlug(domain)) return INVALID;
	return write(
		creds,
		"lookup table create",
		`${root(creds, domain)}/lookup_table/v1/`,
		"POST",
		lookupTableJsonBody(definition),
		async (answer) =>
			answer.status === 201 ? emptyAcknowledgement(answer) : null,
		cancel,
	);
}

/** Replace a held table's definition under its unchanged tag. */
export async function updateHqLookupTableJson(
	creds: CommCareCredentials,
	domain: string,
	tableId: string,
	definition: HqLookupJsonDefinition,
	cancel?: AbortSignal,
): Promise<HqLookupJsonWrite<true>> {
	if (!isValidDomainSlug(domain) || !REMOTE_ID.test(tableId)) return INVALID;
	return write(
		creds,
		"lookup table update",
		`${root(creds, domain)}/lookup_table/v1/${tableId}/`,
		"PUT",
		lookupTableJsonBody(definition),
		async (answer) =>
			answer.status === 204 || answer.status === 200
				? emptyAcknowledgement(answer)
				: null,
		cancel,
	);
}

/**
 * Append one row. The answer is the saved row: its minted id, and the rank
 * CommCare HQ gave it, which is its own, never the body's.
 */
export async function createHqLookupRowJson(
	creds: CommCareCredentials,
	domain: string,
	tableId: string,
	row: HqLookupJsonRow,
	cancel?: AbortSignal,
): Promise<
	HqLookupJsonWrite<{ readonly id: string; readonly sortKey: number }>
> {
	if (
		!isValidDomainSlug(domain) ||
		!REMOTE_ID.test(tableId) ||
		!validSortKey(row.sortKey)
	)
		return INVALID;
	return write(
		creds,
		"lookup row create",
		`${root(creds, domain)}/lookup_table_item/v2/`,
		"POST",
		lookupRowJsonBody(tableId, row),
		async (answer) => {
			if (answer.status !== 201) {
				await answer.discard();
				return null;
			}
			const read = await readAnswerJson(answer, HQ_LOOKUP_DETAIL_MAX_BYTES);
			if (read.kind !== "json") return null;
			const saved = read.data;
			if (
				!isHqObject(saved) ||
				typeof saved.id !== "string" ||
				!REMOTE_ID.test(saved.id) ||
				saved.data_type_id !== tableId ||
				typeof saved.sort_key !== "number" ||
				!validSortKey(saved.sort_key)
			)
				return null;
			return { id: saved.id, sortKey: saved.sort_key };
		},
		cancel,
	);
}

/** Replace one held row whole: its fields, details and rank, in its table. */
export async function updateHqLookupRowJson(
	creds: CommCareCredentials,
	domain: string,
	tableId: string,
	rowId: string,
	row: HqLookupJsonRow,
	cancel?: AbortSignal,
): Promise<HqLookupJsonWrite<true>> {
	if (
		!isValidDomainSlug(domain) ||
		!REMOTE_ID.test(tableId) ||
		!REMOTE_ID.test(rowId) ||
		!validSortKey(row.sortKey)
	)
		return INVALID;
	return write(
		creds,
		"lookup row update",
		`${root(creds, domain)}/lookup_table_item/v2/${rowId}/`,
		"PUT",
		lookupRowJsonBody(tableId, row),
		async (answer) =>
			answer.status === 200 || answer.status === 204
				? emptyAcknowledgement(answer)
				: null,
		cancel,
	);
}

/** Delete one held row by its id. A row already gone is the caller's to read. */
export async function deleteHqLookupRowJson(
	creds: CommCareCredentials,
	domain: string,
	rowId: string,
	cancel?: AbortSignal,
): Promise<HqLookupJsonWrite<true>> {
	if (!isValidDomainSlug(domain) || !REMOTE_ID.test(rowId)) return INVALID;
	return write(
		creds,
		"lookup row delete",
		`${root(creds, domain)}/lookup_table_item/v2/${rowId}/`,
		"DELETE",
		null,
		async (answer) =>
			answer.status === 202 || answer.status === 204
				? emptyAcknowledgement(answer)
				: null,
		cancel,
	);
}
