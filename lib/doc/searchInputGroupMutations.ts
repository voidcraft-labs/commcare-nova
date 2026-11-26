import type { Mutation } from "@/lib/doc/types";
import type { CaseListConfig, SearchInputGroup, Uuid } from "@/lib/domain";
import { sequenceMovesTo } from "./mutations/sequence";
import { searchInputUpdateMutation } from "./searchInputMutations";

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

	const mutations: Mutation[] = [
		{
			kind: "setCaseListMeta",
			uuid: moduleUuid,
			patch: {
				searchInputGroups: sections.length
					? sections.map(({ uuid, label }) => ({ uuid, label }))
					: null,
			},
		},
	];
	for (const input of config.searchInputs) {
		const group = sectionsByField.get(input.uuid);
		if (input.group === group) continue;
		const { group: _group, ...inputSettings } = input;
		mutations.push(
			searchInputUpdateMutation(moduleUuid, input, {
				...inputSettings,
				...(group && { group }),
			}),
		);
	}
	for (const move of sequenceMovesTo(before, order))
		mutations.push({ kind: "moveSearchInput", moduleUuid, ...move });
	return { mutations };
}
