// lib/commcare/suite/case-search/requestOrder.ts
//
// The order a search asks HQ's server to choose its matches in, spelled the
// two ways HQ stores it: the dedicated `custom_sort_properties` rows, and the
// `commcare_sort` text a default filter sends. HQ joins the rows into that
// same text (`suite_xml/post_process/remote_requests.py::
// _remote_request_query_datums`: `{+|-}{property_name}:{sort_type}`, comma
// separated), and its search reads every `commcare_sort` value in request
// order (`case_search/models.py::_parse_commcare_sort_properties`), sorting
// on the value its index holds under that key
// (`es/case_search.py::sort_by_case_property`).

import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import type { SearchRequestOrder } from "@/lib/domain/modules";
import { FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES } from "@/lib/domain/standardCaseProperties";

type Term = SearchRequestOrder[number];

const WIRE_COMPARISON = {
	text: "exact",
	date: "date",
	number: "numeric",
} as const;

/** The record's own attributes, under the keys HQ's index holds them at
 *  (`case_search/const.py::INDEXED_METADATA_BY_KEY`). */
const ATTRIBUTE_KEYS = {
	"@case_id": "case_id",
	"@owner_id": "owner_id",
	"@case_type": "case_type",
	"@status": "status",
} as const;

/** The keys of HQ's index Nova reads as a record's own information. */
export const SERVER_ORDER_RECORD_KEYS: ReadonlySet<string> = new Set([
	...Object.keys(ATTRIBUTE_KEYS),
	"name",
	"case_name",
	"external_id",
	"date_opened",
	"last_modified",
]);

/**
 * Whether an order key names a property Nova reserves: a saved property
 * under a name Nova keeps for a record's own information or CommCare's
 * reserved words (`status` without `@` is what a form saved as `status`, not
 * the record's open or closed state). Nova's catalog holds no such property,
 * so no order of Nova's names it.
 */
export function serverOrderKeyNovaReserves(key: string): boolean {
	return (
		!SERVER_ORDER_RECORD_KEYS.has(key) &&
		FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has(key)
	);
}

/** Whether a literal `commcare_sort` text names a key Nova reserves. */
export function requestOrderTextNamesReserved(text: string): boolean {
	return text
		.split(",")
		.some((part) =>
			serverOrderKeyNovaReserves(
				part.replace(/^[-+]+/, "").split(":")[0] ?? "",
			),
		);
}

/** Whether dedicated sort rows name a key Nova reserves. */
export function dedicatedOrderNamesReserved(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.some(
			(row) =>
				row !== null &&
				typeof row === "object" &&
				typeof (row as Record<string, unknown>).property_name === "string" &&
				serverOrderKeyNovaReserves(
					(row as Record<string, unknown>).property_name as string,
				),
		)
	);
}

/** The key HQ's index holds a term's value under. */
export function requestOrderKey(term: Term): string {
	if (term.recordName) return "name";
	for (const [wire, property] of Object.entries(ATTRIBUTE_KEYS))
		if (term.property === property) return wire;
	return term.property;
}

function readTerm(
	key: string,
	comparison: string,
	direction: "ascending" | "descending",
): Term | undefined {
	const attribute = Object.entries(ATTRIBUTE_KEYS).find(
		([wire]) => wire === key,
	)?.[1];
	if (serverOrderKeyNovaReserves(key)) return;
	const property = attribute ?? (key === "name" ? "case_name" : key);
	if (!authoredCasePropertyNameSchema.safeParse(property).success) return;
	if (
		comparison !== "exact" &&
		comparison !== "numeric" &&
		comparison !== "date"
	)
		return;
	return {
		property,
		...(key === "name" && { recordName: true as const }),
		comparison:
			comparison === "exact"
				? "text"
				: comparison === "numeric"
					? "number"
					: "date",
		direction,
	};
}

/** The dedicated rows HQ's Case Search settings save. */
export function projectRequestOrder(order: SearchRequestOrder) {
	return order.map((term) => ({
		doc_type: "CaseSearchCustomSortProperty" as const,
		property_name: requestOrderKey(term),
		sort_type: WIRE_COMPARISON[term.comparison],
		direction: term.direction,
	}));
}

/** The order the dedicated rows hold, or `undefined` for rows Nova cannot
 *  hold. A row without a type or direction is HQ's default for it
 *  (`sort_property.sort_type or 'exact'`; `direction` defaults to ascending). */
export function readDedicatedOrder(
	value: unknown,
): SearchRequestOrder | undefined {
	if (!Array.isArray(value) || value.length === 0) return;
	const order: Term[] = [];
	for (const row of value) {
		if (row === null || typeof row !== "object") return;
		const { property_name, sort_type, direction } = row as Record<
			string,
			unknown
		>;
		if (typeof property_name !== "string") return;
		if (
			sort_type !== undefined &&
			sort_type !== null &&
			typeof sort_type !== "string"
		)
			return;
		if (
			direction !== undefined &&
			direction !== "ascending" &&
			direction !== "descending"
		)
			return;
		const term = readTerm(
			property_name,
			sort_type || "exact",
			direction ?? "ascending",
		);
		if (term === undefined) return;
		order.push(term);
	}
	return order as SearchRequestOrder;
}

/** The `commcare_sort` text a default filter sends for `order`. */
export function requestOrderText(order: SearchRequestOrder): string {
	return order
		.map(
			(term) =>
				(term.implicitDirection
					? ""
					: term.direction === "descending"
						? "-"
						: "+") +
				requestOrderKey(term) +
				(term.implicitComparison ? "" : `:${WIRE_COMPARISON[term.comparison]}`),
		)
		.join(",");
}

/** The order a literal `commcare_sort` text names, or `undefined` for text
 *  Nova cannot hold. HQ reads a leading `-` as descending and anything else
 *  as ascending; a part with two signs or more than one `:` is refused here
 *  although HQ would read it. */
export function readRequestOrderText(
	text: string,
): SearchRequestOrder | undefined {
	const order: Term[] = [];
	for (const part of text.split(",")) {
		if (/^[+-]{2}/.test(part)) return;
		const signed = /^[+-]/.test(part);
		const [key, comparison, ...extra] = part.replace(/^[-+]+/, "").split(":");
		if (extra.length > 0 || key === undefined) return;
		const term = readTerm(
			key,
			comparison ?? "exact",
			part.startsWith("-") ? "descending" : "ascending",
		);
		if (term === undefined) return;
		order.push({
			...term,
			...(comparison === undefined && { implicitComparison: true as const }),
			...(!signed && { implicitDirection: true as const }),
		});
	}
	return order as SearchRequestOrder;
}
