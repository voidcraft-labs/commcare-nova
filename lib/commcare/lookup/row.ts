import type { LookupValueSlot } from "@/lib/lookup/largeValues/input";
import type {
	LookupColumn,
	LookupFixtureRow,
	LookupMember,
} from "@/lib/lookup/types";
import { lookupFixtureCellText } from "./cellText";

type FixtureTable = {
	rowElementName: string;
	columns: readonly LookupColumn[];
	attributes?: readonly LookupMember[];
};
export interface FixtureAtom {
	readonly slot: LookupValueSlot;
	readonly text: string;
}
interface NamedAtom extends FixtureAtom {
	readonly name: string;
}
interface FixtureField extends FixtureAtom {
	readonly name: string;
	readonly attributes: Iterable<NamedAtom>;
}

function* attributes(
	table: FixtureTable,
	row: LookupFixtureRow,
): Generator<NamedAtom> {
	for (const member of table.attributes ?? []) {
		const text = row.attributes?.[member.id];
		if (text === undefined)
			throw new Error(
				`A row in “${table.rowElementName}” is missing its “${member.wireName}” detail. You can restore the value in Project data or refresh the source table.`,
			);
		yield {
			name: member.wireName,
			slot: { kind: "attribute", attributeId: member.id },
			text,
		};
	}
}
function* fields(
	table: FixtureTable,
	row: LookupFixtureRow,
): Generator<FixtureField> {
	for (const column of table.columns) {
		const columnId = column.id;
		const occurrences = row.occurrences?.[columnId];
		if (occurrences === undefined) {
			yield {
				name: column.wireName,
				slot: { kind: "cell", columnId },
				text: lookupFixtureCellText(column.dataType, row.values[columnId]),
				attributes: [],
			};
			continue;
		}
		for (const [index, item] of occurrences.entries()) {
			function* properties(): Generator<NamedAtom> {
				for (const member of column.properties ?? []) {
					const text = item.properties[member.id];
					if (text !== undefined)
						yield {
							name: member.wireName,
							text,
							slot: {
								kind: "property",
								columnId,
								index,
								propertyId: member.id,
							},
						};
				}
			}
			yield {
				name: column.wireName,
				slot: { kind: "occurrence", columnId, index },
				text: item.text,
				attributes: properties(),
			};
		}
	}
}

/** Every wire reader walks the same declared members, including the single
 * empty child HQ supplies for an absent field and zero children for []. */
export function workerFixtureAtoms(table: FixtureTable, row: LookupFixtureRow) {
	return {
		name: table.rowElementName,
		attributes: attributes(table, row),
		children: fields(table, row),
	};
}
export function workerFixtureRow(table: FixtureTable, row: LookupFixtureRow) {
	const root = workerFixtureAtoms(table, row);
	const values = (items: Iterable<NamedAtom>) =>
		Object.fromEntries(Array.from(items, (item) => [item.name, item.text]));
	return {
		name: root.name,
		attributes: values(root.attributes),
		children: Array.from(root.children, (child) => ({
			name: child.name,
			value: child.text,
			attributes: values(child.attributes),
		})),
	};
}
