import { v7 } from "uuid";
import type { LookupWorkerProjection } from "@/lib/commcare/hq/lookupRestore";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";

/** Bind the authorized device fixture by schema, never by matching values
 * to inventory rows. Row identities are local to this one worker snapshot. */
export function bindWorkerFixtureRows(
	definition: LookupTableDefinition,
	projection: Pick<LookupWorkerProjection, "rows">,
): LookupFixtureRow[] {
	const columns = new Map(
		definition.columns.map((column) => [column.wireName, column]),
	);
	const attributes = new Map(
		definition.attributes?.map((member) => [member.wireName, member]),
	);
	const mismatch = () =>
		new LookupError(
			"managed_in_hq",
			`The worker's copy of “${definition.name}” has different columns or details. You can refresh the table in Project data and open the app again.`,
		);
	return projection.rows.map((incoming) => {
		const attributesById: NonNullable<LookupFixtureRow["attributes"]> = {};
		const occurrences: NonNullable<LookupFixtureRow["occurrences"]> = {};
		const row: LookupFixtureRow = {
			id: lookupRowIdSchema.parse(v7()),
			values: {},
			attributes: attributesById,
			occurrences,
		};
		for (const [name, value] of Object.entries(incoming.attributes)) {
			const member = attributes.get(name);
			if (!member) throw mismatch();
			attributesById[member.id] = value;
		}
		if (Object.keys(incoming.attributes).length !== attributes.size)
			throw mismatch();
		const byColumn = new Map<string, (typeof incoming.fields)[number][]>();
		let previous = -1;
		for (const field of incoming.fields) {
			const column = columns.get(field.name);
			if (!column) throw mismatch();
			const position = definition.columns.indexOf(column);
			if (position < previous) throw mismatch();
			previous = position;
			const group = byColumn.get(field.name) ?? [];
			group.push(field);
			byColumn.set(field.name, group);
		}
		for (const column of definition.columns) {
			const fields = byColumn.get(column.wireName) ?? [];
			if (
				!column.repeated &&
				fields.length === 1 &&
				Object.keys(fields[0].properties).length === 0
			) {
				// HQ source columns always have text type, whatever their spelling.
				if (column.dataType !== "text") throw mismatch();
				row.values[column.id] = fields[0].text;
				continue;
			}
			occurrences[column.id] = fields.map((field) => {
				const props = Object.entries(field.properties).map(([name, value]) => {
					const member = column.properties?.find(
						(property) => property.wireName === name,
					);
					if (!member) throw mismatch();
					return [member.id, value] as const;
				});
				return { text: field.text, properties: Object.fromEntries(props) };
			});
		}
		return row;
	});
}
