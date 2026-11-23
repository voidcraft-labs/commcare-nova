import type { BlueprintDoc, CaseListConfig, Column, Uuid } from "@/lib/domain";
import { type DetailTab, detailTabMembership } from "@/lib/domain/detailTabs";
import type { Expression } from "@/lib/domain/expression";
import { columnAddMutation } from "./caseListColumnMutations";
import { deepEqual } from "./deepEqual";
import { withDetailFieldLayout } from "./detailFieldVisibility";
import { sequenceMovesTo } from "./mutations/sequence";
import type { Mutation } from "./types";

export interface DetailTabGroup {
	readonly uuid: Uuid;
	readonly title: string;
	readonly displayCondition?: DetailTab["displayCondition"] | null;
	readonly rowSource?: DetailTab["rowSource"] | null;
	readonly orderFields?: readonly Uuid[] | null;
	readonly fields: readonly Uuid[];
	readonly newFields?: readonly {
		uuid: Uuid;
		header: string;
		expression: Expression;
	}[];
}

/** Replacing the visible partition preserves every hidden column's position. A
 * group always travels with all of its fields, including those behind its first. */
export function planDetailTabGroups(
	moduleUuid: Uuid,
	initial: CaseListConfig,
	requestedGroups: readonly DetailTabGroup[],
): { mutations: Mutation[] } | { error: string } {
	const additions: Mutation[] = [];
	const appended: Column[] = [];
	let listAnchor = initial.listColumnOrder.at(-1) ?? null;
	let detailAnchor = initial.detailColumnOrder.at(-1) ?? null;
	const groups = requestedGroups.map((group) => {
		const newFields = group.newFields ?? [];
		for (const value of newFields) {
			const column: Column = {
				kind: "calculated",
				uuid: value.uuid,
				header: value.header,
				expression: value.expression,
				...(value.expression.kind === "term" &&
					(value.expression.term.kind === "table-column" ||
						value.expression.term.kind === "location-field") && {
						rowField: true,
					}),
				visibleInList: false,
				notOnList: true,
			};
			additions.push(
				columnAddMutation(moduleUuid, column, {
					afterInList: listAnchor,
					afterInDetail: detailAnchor,
				}),
			);
			appended.push(column);
			listAnchor = detailAnchor = column.uuid;
		}
		return {
			...group,
			fields: [...group.fields, ...newFields.map((value) => value.uuid)],
		};
	});
	const config = appended.length
		? {
				...initial,
				columns: [...initial.columns, ...appended],
				detailColumnOrder: [
					...initial.detailColumnOrder,
					...appended.map((col) => col.uuid),
				],
			}
		: initial;
	const fields = groups.flatMap((group) => group.fields);
	const visible = new Set(
		config.columns
			.filter((column) => column.visibleInDetail !== false)
			.map((column) => column.uuid),
	);
	if (
		groups.length &&
		(visible.size !== fields.length ||
			new Set(fields).size !== fields.length ||
			fields.some((uuid) => !visible.has(uuid)))
	) {
		return {
			error:
				"Each field shown in Details needs one place in a tab. Open Details to check the current fields.",
		};
	}
	if (new Set(groups.map((group) => group.uuid)).size !== groups.length)
		return { error: "Each tab needs its own identity." };
	const previous = new Map(config.detailTabs?.map((tab) => [tab.uuid, tab]));
	const tabs: DetailTab[] = [];
	for (const group of groups) {
		const first = group.fields[0];
		if (!first || !group.title.trim())
			return { error: "A tab needs a title and at least one field." };
		const tab = {
			...previous.get(group.uuid),
			uuid: group.uuid,
			title: group.title.trim(),
			startColumnUuid: first,
		};
		if (group.displayCondition === null) delete tab.displayCondition;
		else if (group.displayCondition !== undefined)
			tab.displayCondition = group.displayCondition;
		if (group.rowSource === null) delete tab.rowSource;
		else if (group.rowSource !== undefined) tab.rowSource = group.rowSource;
		const orderable = (uuid: Uuid) =>
			config.columns.some(
				(column) =>
					column.uuid === uuid &&
					(column.kind === "plain" || column.kind === "calculated"),
			);
		if (
			group.orderFields &&
			(new Set(group.orderFields).size !== group.orderFields.length ||
				group.orderFields.some((uuid) => !group.fields.includes(uuid)) ||
				(group.orderFields.length > 0 && !tab.rowSource))
		)
			return {
				error:
					"Ordering fields must each belong to this tab and have a list of records to order.",
			};
		if (group.orderFields?.some((uuid) => !orderable(uuid)))
			return {
				error:
					"A tab of records orders its rows by text or calculated fields. Choose those fields to order by.",
			};
		// Left out, a tab keeps its ordering fields that are still its own
		// and can still order, in its new Details order.
		const wanted =
			group.orderFields === undefined
				? (tab.orderFields ?? [])
				: (group.orderFields ?? []);
		const orderFields = group.fields.filter(
			(uuid) => wanted.includes(uuid) && orderable(uuid),
		);
		if (orderFields.length === 0 || !tab.rowSource) delete tab.orderFields;
		else tab.orderFields = orderFields;
		tabs.push(tab);
	}
	let index = 0;
	const order = groups.length
		? config.detailColumnOrder.map((uuid) =>
				visible.has(uuid) ? (fields[index++] as Uuid) : uuid,
			)
		: config.detailColumnOrder;
	const mutations: Mutation[] = sequenceMovesTo(
		config.detailColumnOrder,
		order,
	).map((move) => ({
		kind: "moveColumn",
		moduleUuid,
		surface: "detail",
		uuid: move.uuid,
		after: move.after,
	}));
	if (
		!deepEqual(config.detailTabs ?? [], tabs) ||
		(tabs.length > 0 && mutations.length > 0)
	)
		mutations.push({
			kind: "setCaseListMeta",
			uuid: moduleUuid,
			patch: { detailTabs: tabs.length ? tabs : null },
		});
	return {
		mutations: withDetailFieldLayout(moduleUuid, initial, [
			...additions,
			...mutations,
		]),
	};
}

/** In a plain field reorder, each field stays with the tab the author put it
 * in. Reordering inside that group can change its first field. A field can
 * move to another group only when the editor describes that grouping. */
export function reorderDetailTabFields(
	moduleUuid: Uuid,
	config: CaseListConfig,
	requested: readonly Uuid[],
): { mutations: Mutation[] } | { error: string } {
	if (!config.detailTabs) return { mutations: [] };
	const old = detailTabMembership(config);
	const groups: DetailTabGroup[] = [];
	const seen = new Set<Uuid>();
	for (const field of requested) {
		const owner = old.get(field);
		if (!owner) continue;
		const last = groups.at(-1);
		if (last?.uuid === owner.uuid) {
			groups[groups.length - 1] = { ...last, fields: [...last.fields, field] };
			continue;
		}
		if (seen.has(owner.uuid))
			return {
				error:
					"That order would split a tab. Open Edit tabs to choose which fields belong together.",
			};
		seen.add(owner.uuid);
		groups.push({ ...owner, fields: [field] });
	}
	return planDetailTabGroups(moduleUuid, config, groups);
}

/** Recheck the old and new field identities at admission. A stale neighbor
 * from another editor may still exist after its tab membership changed. */
export function implicitTabMembershipChange(
	before: BlueprintDoc,
	after: BlueprintDoc,
	mutations: readonly Mutation[],
): Uuid | undefined {
	const moved = new Set<Uuid>();
	const explicit = new Set<Uuid>();
	for (const m of mutations) {
		if (m.kind === "moveColumn" && m.surface === "detail")
			moved.add(m.moduleUuid);
		if (m.kind === "setCaseListMeta" && "detailTabs" in m.patch)
			explicit.add(m.uuid);
	}
	for (const uuid of moved) {
		const previous = before.modules[uuid]?.caseListConfig;
		const next = after.modules[uuid]?.caseListConfig;
		if (!previous?.detailTabs || !next?.detailTabs || explicit.has(uuid))
			continue;
		const prior = detailTabMembership(previous);
		for (const [id, tab] of detailTabMembership(next)) {
			if (prior.has(id) && prior.get(id)?.uuid !== tab.uuid) return uuid;
		}
	}
}
