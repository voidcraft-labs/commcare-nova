import type { Selectable, Transaction } from "kysely";
import type {
	AppDatabase,
	LookupColumnsTable,
	LookupMembersTable,
} from "@/lib/db/pg";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import { assertMemberRemovable } from "./memberGovernance";
import type { LookupColumn, LookupMember, LookupMemberDraft } from "./types";

type StoredMember = Selectable<LookupMembersTable>;

export function columnWithMembers(
	column: Selectable<LookupColumnsTable>,
	properties: readonly LookupMember[] = [],
): LookupColumn {
	return {
		id: column.id,
		wireName: column.wire_name,
		label: column.label,
		dataType: column.data_type,
		...(column.repeated ? { repeated: true } : {}),
		...(properties.length ? { properties } : {}),
		...(column.index_status === "off" ? {} : { index: column.index_status }),
	};
}

export function memberGroups(
	members: readonly StoredMember[],
): Map<LookupColumnId | null, LookupMember[]> {
	const groups = new Map<LookupColumnId | null, LookupMember[]>();
	for (const row of members) {
		const group = groups.get(row.column_id) ?? [];
		group.push({ id: row.id, wireName: row.wire_name, label: row.label });
		groups.set(row.column_id, group);
	}
	return groups;
}

export async function readTableMembers(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
) {
	return memberGroups(
		await tx
			.selectFrom("lookup_members")
			.selectAll()
			.where("project_id", "=", projectId)
			.where("table_id", "=", tableId)
			.orderBy("position")
			.orderBy("id")
			.execute(),
	);
}

export async function insertLookupMembers(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId | null,
	drafts: readonly LookupMemberDraft[],
	ids?: Readonly<Record<string, LookupMemberId>>,
): Promise<LookupMember[]> {
	if (
		ids &&
		(drafts.length !== Object.keys(ids).length ||
			drafts.some((member) => !Object.hasOwn(ids, member.wireName)))
	)
		throw new Error(
			"A managed detail binding does not match its scoped definition.",
		);
	if (!drafts.length) return [];
	const named = await tx
		.insertInto("lookup_members")
		.values(
			drafts.map((draft, position) => ({
				project_id: projectId,
				table_id: tableId,
				column_id: columnId,
				wire_name: draft.wireName,
				label: draft.label,
				position,
				...(ids === undefined
					? {}
					: {
							id: Object.hasOwn(ids, draft.wireName)
								? ids[draft.wireName]
								: undefined,
						}),
			})),
		)
		.returningAll()
		.execute();
	return (
		memberGroups(named.sort((a, b) => a.position - b.position)).get(columnId) ??
		[]
	);
}

/** Only replace source shape under the table lock. Stable identities survive
 * reordering. Reference FKs guard every removed member, including references
 * of an archived app; the caller has checked its pending design protections. */
export async function updateLookupMembers(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	previous: ReadonlyMap<LookupColumnId | null, readonly LookupMember[]>,
	next: ReadonlyMap<LookupColumnId | null, readonly LookupMember[]>,
	owners: readonly (LookupColumnId | null)[],
): Promise<boolean> {
	let changed = false;
	for (const owner of owners) {
		const before = previous.get(owner) ?? [];
		const after = next.get(owner) ?? [];
		const newIds = new Set(after.map((member) => member.id));
		const removed = before.filter((member) => !newIds.has(member.id));
		if (removed.length) {
			for (const member of removed)
				await assertMemberRemovable(tx, projectId, tableId, owner, member.id);
			await tx
				.deleteFrom("lookup_members")
				.where("project_id", "=", projectId)
				.where("table_id", "=", tableId)
				.where(
					"id",
					"in",
					removed.map((member) => member.id),
				)
				.execute();
			changed = true;
		}
		const beforePosition = new Map<LookupMemberId, number>(
			before.map((member, index) => [member.id, index]),
		);
		const added = after.flatMap((member, position) =>
			beforePosition.has(member.id)
				? []
				: [
						{
							project_id: projectId,
							table_id: tableId,
							column_id: owner,
							id: member.id,
							position,
							wire_name: member.wireName,
							label: member.label,
						},
					],
		);
		if (added.length) {
			await tx.insertInto("lookup_members").values(added).execute();
			changed = true;
		}
		for (const [position, member] of after.entries()) {
			const was = beforePosition.get(member.id);
			if (
				was === undefined ||
				(was === position &&
					before[was].wireName === member.wireName &&
					before[was].label === member.label)
			)
				continue;
			await tx
				.updateTable("lookup_members")
				.set({ position, wire_name: member.wireName, label: member.label })
				.where("project_id", "=", projectId)
				.where("table_id", "=", tableId)
				.where("id", "=", member.id)
				.execute();
			changed = true;
		}
	}
	return changed;
}
