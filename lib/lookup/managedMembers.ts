import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupColumnId,
	lookupMemberIdSchema,
} from "@/lib/domain/lookupIds";
import { ownRecordValue } from "@/lib/domain/records";
import type { ManagedLookupMemberIds } from "./authoringBatch";
import { LookupError } from "./errors";
import { columnLabelFor, type ManagedLookupContent } from "./managedRules";
import { lookupMemberDraftSchema } from "./schema";
import type { LookupColumn, LookupMember } from "./types";

/** Bind the row attributes and the members of each repeated value independently.
 * A wire name only identifies a member within its owning table or column. */
export async function bindManagedMembers(
	tx: Transaction<AppDatabase>,
	content: ManagedLookupContent,
	columnIdOf: ReadonlyMap<string, LookupColumnId>,
	previous: ReadonlyMap<LookupColumnId | null, readonly LookupMember[]>,
	proposed?: ManagedLookupMemberIds,
) {
	const groups = [
		{
			owner: null as LookupColumnId | null,
			names: content.attributes ?? [],
			ids: proposed?.attributes,
		},
		...Array.from(columnIdOf, ([name, owner]) => ({
			owner,
			names: ownRecordValue(content.fieldDetails, name)?.properties ?? [],
			ids: ownRecordValue(proposed?.properties, name),
		})),
	];
	const plans = groups.flatMap(({ owner, names, ids }) => {
		if (new Set(names).size !== names.length)
			throw new LookupError(
				"invalid_input",
				"The source repeats a detail name in the same definition. You can correct its definition and refresh.",
			);
		const stored = new Map(
			previous.get(owner)?.map((member) => [member.wireName, member]),
		);
		return names.map((name, position) => {
			if (!lookupMemberDraftSchema.shape.wireName.safeParse(name).success)
				throw new LookupError(
					"invalid_input",
					"A source detail has a name Nova cannot read. You can update its name and refresh.",
				);
			const held = stored.get(name);
			const supplied = ownRecordValue(ids, name);
			if (held && supplied && held.id !== supplied)
				throw new LookupError(
					"conflict",
					"A detail changed since the table was read. You can refresh the table.",
				);
			const id =
				held?.id ??
				(supplied === undefined
					? undefined
					: lookupMemberIdSchema.parse(supplied));
			return {
				owner,
				name,
				position,
				id,
				label: held?.label ?? columnLabelFor(name),
			};
		});
	});
	const missing = plans.filter((p) => p.id === undefined).length;
	const minted = missing
		? (
				await sql<{
					id: string;
				}>`SELECT uuidv7()::text AS id FROM generate_series(1, ${missing}::integer)`.execute(
					tx,
				)
			).rows
		: [];
	let nextId = 0;
	const members = new Map<LookupColumnId | null, LookupMember[]>();
	for (const plan of plans) {
		const group = members.get(plan.owner) ?? [];
		group.push({
			id: plan.id ?? lookupMemberIdSchema.parse(minted[nextId++].id),
			wireName: plan.name,
			label: plan.label,
		});
		members.set(plan.owner, group);
	}
	const attributes = members.get(null) ?? [];
	const columns: LookupColumn[] = Array.from(columnIdOf, ([wireName, id]) => {
		const detail = ownRecordValue(content.fieldDetails, wireName);
		const properties = members.get(id) ?? [];
		if (properties.length && !detail?.repeated)
			throw new LookupError(
				"invalid_input",
				"A column with value details needs to hold repeated text.",
			);
		const index = detail?.index ?? "unobserved";
		return {
			id,
			wireName,
			label: columnLabelFor(wireName),
			dataType: "text",
			...(properties.length ? { properties } : {}),
			...(detail?.repeated ? { repeated: true } : {}),
			...(index === "off" ? {} : { index }),
		};
	});
	const idsFor = (list: readonly LookupMember[]) =>
		Object.fromEntries(list.map((member) => [member.wireName, member.id]));
	const memberIds: ManagedLookupMemberIds = {
		attributes: idsFor(attributes),
		properties: Object.fromEntries(
			columns.map((column) => [
				column.wireName,
				idsFor(column.properties ?? []),
			]),
		),
	};
	return { columns, attributes, memberIds, members };
}
