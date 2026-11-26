import { lookupColumnIdSchema } from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import { lookupRowContentSchema } from "./schema";
import type {
	LookupColumn,
	LookupMember,
	LookupRowContent,
	LookupRowValues,
} from "./types";

/** Validate the whole authored row against the locked, current definition,
 * including members currently hidden in the editor. Scalar values have
 * already gone through the existing typed cell validator. */
export function checkedRowContent(
	columns: readonly LookupColumn[],
	attributes: readonly LookupMember[],
	values: LookupRowValues,
	input: unknown,
): LookupRowContent {
	const parsed = lookupRowContentSchema.safeParse(input);
	if (!parsed.success)
		throw new LookupError(
			"invalid_input",
			parsed.error.issues[0]?.message ??
				"This row contains invalid text or details.",
		);
	const content = parsed.data;
	const allowed = new Set(attributes.map((member) => member.id));
	for (const member of attributes)
		if (!Object.hasOwn(content.attributes ?? {}, member.id))
			throw new LookupError(
				"invalid_input",
				`This row needs a value for “${member.label}”. You can leave the text empty.`,
			);
	for (const key of Object.keys(content.attributes ?? {}))
		if (!attributes.some((member) => member.id === key))
			throw new LookupError(
				"invalid_input",
				"A row detail no longer belongs to this table. You can refresh the table.",
			);
	const byId = new Map(columns.map((column) => [column.id, column]));
	for (const id of Object.keys(values)) {
		if (byId.get(lookupColumnIdSchema.parse(id))?.repeated)
			throw new LookupError(
				"invalid_input",
				"This column holds a list of values. You can edit its values in order.",
			);
	}
	for (const [id, occurrences] of Object.entries(content.occurrences ?? {})) {
		const column = byId.get(lookupColumnIdSchema.parse(id));
		if (!column?.repeated)
			throw new LookupError(
				"invalid_input",
				"These values need a repeated text column in this table.",
			);
		const properties = new Set<string>(
			column.properties?.map((member) => member.id),
		);
		for (const occurrence of occurrences)
			for (const property of Object.keys(occurrence.properties))
				if (!properties.has(property))
					throw new LookupError(
						"invalid_input",
						`A value detail no longer belongs to “${column.label}”. You can refresh the table.`,
					);
	}
	return {
		...(allowed.size ? { attributes: content.attributes } : {}),
		...(Object.keys(content.occurrences ?? {}).length
			? { occurrences: content.occurrences }
			: {}),
	};
}

export interface NamedLookupRowContent {
	attributes?: Readonly<Record<string, string>>;
	occurrences?: Readonly<
		Record<
			string,
			readonly { text: string; properties: Readonly<Record<string, string>> }[]
		>
	>;
}

/** Bind source spellings exactly once under the table lock. The Project
 * store and every reader above it carry identities for these values. */
export function resolveNamedRowContent(
	columns: readonly LookupColumn[],
	attributes: readonly LookupMember[],
	values: LookupRowValues,
	content: NamedLookupRowContent,
): LookupRowContent {
	const memberValues = (
		members: readonly LookupMember[],
		named: Readonly<Record<string, string>>,
	) => {
		const byName = new Map(
			members.map((member) => [member.wireName, member.id]),
		);
		return Object.fromEntries(
			Object.entries(named).map(([name, text]) => {
				const id = byName.get(name);
				if (id === undefined)
					throw new LookupError(
						"invalid_input",
						`The detail “${name}” does not belong here.`,
					);
				return [id, text];
			}),
		);
	};
	const byName = new Map(columns.map((column) => [column.wireName, column]));
	return checkedRowContent(columns, attributes, values, {
		attributes: memberValues(attributes, content.attributes ?? {}),
		occurrences: Object.fromEntries(
			Object.entries(content.occurrences ?? {}).map(([name, list]) => {
				const column = byName.get(name);
				if (!column?.repeated)
					throw new LookupError(
						"invalid_input",
						`The table has no repeated column named “${name}”.`,
					);
				return [
					column.id,
					list.map((item) => ({
						text: item.text,
						properties: memberValues(column.properties ?? [], item.properties),
					})),
				];
			}),
		),
	});
}
