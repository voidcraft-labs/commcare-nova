import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";

interface LookupLexicalSlot {
	label: string;
	wireName: string;
	target: Record<string, string>;
	values(row: LookupFixtureRow): Iterable<string>;
}

/** Group by stable member for a precise, bounded export finding. A row can
 * contribute once to a finding even if many occurrences fail in that row. */
export function* lookupLexicalSlots(
	table: LookupTableDefinition,
): Generator<LookupLexicalSlot> {
	for (const attribute of table.attributes ?? [])
		yield {
			label: attribute.label,
			wireName: attribute.wireName,
			target: { memberId: attribute.id },
			*values(row: LookupFixtureRow) {
				const value = row.attributes?.[attribute.id];
				if (value !== undefined) yield value;
			},
		};
	for (const column of table.columns) {
		yield {
			label: column.label,
			wireName: column.wireName,
			target: { columnId: column.id },
			*values(row: LookupFixtureRow) {
				const items = row.occurrences?.[column.id];
				if (items) {
					for (const item of items) yield item.text;
				} else {
					const value = row.values[column.id];
					if (typeof value === "string") yield value;
				}
			},
		};
		for (const property of column.properties ?? [])
			yield {
				label: property.label,
				wireName: property.wireName,
				target: { columnId: column.id, memberId: property.id },
				*values(row: LookupFixtureRow) {
					for (const item of row.occurrences?.[column.id] ?? []) {
						const value = item.properties[property.id];
						if (value !== undefined) yield value;
					}
				},
			};
	}
}
