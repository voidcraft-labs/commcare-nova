import type { Mutation } from "@/lib/doc/types";
import type { CaseListConfig, SearchInputGroup, Uuid } from "@/lib/domain";
import { sequenceMovesTo } from "./mutations/sequence";

export type SearchGroupLayout = SearchInputGroup & {
	readonly inputs: readonly Uuid[];
};

/** Change headings, membership and field order together. */
export function planSearchInputGroups(
	moduleUuid: Uuid,
	config: CaseListConfig,
	sections: readonly SearchGroupLayout[],
): { mutations: Mutation[] } | { error: string } {
	const before = config.searchInputs.map((input) => input.uuid);
	if (sections.length && !before.length)
		return { error: "Add a Search field before adding headings." };
	const sectionsByField = new Map(
		sections.flatMap((section) =>
			section.inputs.map((input) => [input, section.uuid] as const),
		),
	);
	const order = sections.length
		? sections.flatMap((section) => section.inputs)
		: before;
	if (
		sections.length &&
		(order.length !== before.length ||
			sectionsByField.size !== before.length ||
			before.some((id) => !sectionsByField.has(id)))
	) {
		return { error: "Put every Search field under one heading." };
	}

	const searchGroupAssignments = config.searchInputs.flatMap((input) => {
		const group = sectionsByField.get(input.uuid);
		return input.group === group
			? []
			: [{ input: input.uuid, group: group ?? null }];
	});
	const mutations: Mutation[] = [
		{
			kind: "setCaseListMeta",
			uuid: moduleUuid,
			patch: {
				searchInputGroups: sections.length
					? sections.map(({ uuid, label }) => ({ uuid, label }))
					: null,
				...(searchGroupAssignments.length > 0 && { searchGroupAssignments }),
			},
		},
	];
	for (const move of sequenceMovesTo(before, order))
		mutations.push({ kind: "moveSearchInput", moduleUuid, ...move });
	return { mutations };
}
