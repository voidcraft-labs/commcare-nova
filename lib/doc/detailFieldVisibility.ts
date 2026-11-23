import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import type { CaseListConfig, Uuid } from "@/lib/domain";
import { detailTabMembership } from "@/lib/domain/detailTabs";
import { nextFreeTilePlacement } from "@/lib/domain/tilePlacement";
import { spliceAfter } from "./mutations/sequence";

/** Apply field visibility and layout together. A tab keeps its first surviving
 * field and an empty group goes away. New fields inherit the preceding group,
 * or the first group when inserted at the top. An explicit layout or grouping
 * in the same batch always wins. Every derived edit is in the mutation log. */
export function withDetailFieldLayout(
	moduleUuid: Uuid,
	config: CaseListConfig | undefined,
	mutations: readonly Mutation[],
): Mutation[] {
	const result = [...mutations];
	if (!config || (!config.detailTabs && !config.detailTile)) return result;
	const changes = new Map<Uuid, boolean>();
	let sequence = config.detailColumnOrder;
	let grouped = false;
	let laidOut = false;
	for (const m of mutations) {
		if (m.kind === "setCaseListMeta" && m.uuid === moduleUuid) {
			grouped ||= "detailTabs" in m.patch;
			laidOut ||= "detailTile" in m.patch;
		}
		if (!("moduleUuid" in m) || m.moduleUuid !== moduleUuid) continue;
		if (m.kind === "addColumn") {
			sequence = spliceAfter(sequence, m.column.uuid, m.afterInDetail);
			changes.set(m.column.uuid, m.column.visibleInDetail !== false);
		} else if (m.kind === "removeColumn") changes.set(m.uuid, false);
		else if (
			m.kind === "updateColumn" &&
			m.visibilityPatch?.surface === "detail"
		)
			changes.set(m.uuid, m.visibilityPatch.visible);
	}
	if (!changes.size) return result;
	const before = new Set(
		config.columns
			.filter((c) => c.visibleInDetail !== false)
			.map((c) => c.uuid),
	);
	const shown = sequence.filter((id) => changes.get(id) ?? before.has(id));
	const patch: Extract<Mutation, { kind: "setCaseListMeta" }>["patch"] = {};
	if (config.detailTabs && !grouped) {
		const prior = detailTabMembership(config);
		const fields = new Map<Uuid, Uuid[]>();
		let owner = config.detailTabs[0];
		for (const id of shown) {
			owner = prior.get(id) ?? owner;
			const group = fields.get(owner.uuid);
			if (group) group.push(id);
			else fields.set(owner.uuid, [id]);
		}
		const tabs = config.detailTabs.flatMap((tab) => {
			const members = fields.get(tab.uuid);
			if (!members) return [];
			const { orderFields, ...body } = tab;
			const ordering = orderFields?.filter((id) => members.includes(id));
			return [
				{
					...body,
					startColumnUuid: members[0],
					...(ordering?.length && { orderFields: ordering }),
				},
			];
		});
		if (!deepEqual(tabs, config.detailTabs))
			patch.detailTabs = tabs.length ? tabs : null;
	}
	if (config.detailTile && !laidOut) {
		const cells = { ...config.detailTile.cells };
		for (const [id, visible] of changes) if (!visible) delete cells[id];
		for (const id of shown) {
			if (cells[id]) continue;
			const free = nextFreeTilePlacement(Object.values(cells));
			if (free) cells[id] = free;
		}
		if (!deepEqual(cells, config.detailTile.cells))
			patch.detailTile = Object.keys(cells).length ? { cells } : null;
	}
	if (Object.keys(patch).length)
		result.push({ kind: "setCaseListMeta", uuid: moduleUuid, patch });
	return result;
}
