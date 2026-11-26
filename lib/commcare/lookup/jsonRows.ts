/**
 * A Nova table in the shape CommCare HQ's JSON lookup resources take it
 * (`lib/commcare/hq/lookupJson.ts`): its definition, and each row's ordered
 * field values with their properties and the row's details.
 *
 * The row is the worker's fixture row, walked by the same atoms
 * (`row.ts::workerFixtureAtoms`): a scalar column is one value, a column
 * with occurrences one value per occurrence (none for an empty list), each
 * with the properties it holds. So the row CommCare HQ stores serves the
 * fixture Nova's own emitter would build from the same row.
 */

import type { HqLookupJsonDefinition } from "@/lib/commcare/hq/lookupJson";
import { recordFromEntries } from "@/lib/domain/records";
import type { LookupFixtureRow } from "@/lib/lookup/types";
import type { LookupTableWireNaming } from "./naming";
import { workerFixtureAtoms } from "./row";

/** A row's content as the JSON row resource carries it, without its rank. */
export interface LookupJsonRowContent {
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
}

/** The table's definition: its tag, its fields with their properties, its row details. */
export function lookupJsonDefinition(
	table: LookupTableWireNaming,
): HqLookupJsonDefinition {
	return {
		tag: table.tag,
		fields: table.columns.map((column) => ({
			name: column.wireName,
			properties: (column.properties ?? []).map((member) => member.wireName),
		})),
		itemAttributes: (table.attributes ?? []).map((member) => member.wireName),
	};
}

/** One row as the JSON row resource stores it. A row missing a declared detail throws. */
export function lookupJsonRowContent(
	table: LookupTableWireNaming,
	row: LookupFixtureRow,
): LookupJsonRowContent {
	const atoms = workerFixtureAtoms(table, row);
	const itemAttributes: [string, string][] = [];
	for (const attribute of atoms.attributes)
		itemAttributes.push([attribute.name, attribute.text]);
	const fields = new Map<
		string,
		{ value: string; properties: Record<string, string> }[]
	>(table.columns.map((column) => [column.wireName, []]));
	for (const child of atoms.children) {
		const properties: [string, string][] = [];
		for (const property of child.attributes)
			properties.push([property.name, property.text]);
		fields.get(child.name)?.push({
			value: child.text,
			properties: recordFromEntries(properties),
		});
	}
	/* A repeated column the row holds no list of is a field the row does not
	 * hold, which CommCare HQ's row keeps as no key at all: its restore then
	 * writes the one empty element the worker fixture writes for it
	 * (`fixturegenerators.py::ItemListsProvider.to_xml`). */
	for (const column of table.columns)
		if (column.repeated && row.occurrences?.[column.id] === undefined)
			fields.delete(column.wireName);
	return {
		fields: recordFromEntries([...fields]),
		itemAttributes: recordFromEntries(itemAttributes),
	};
}
