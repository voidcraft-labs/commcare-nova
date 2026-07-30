// Search-input identity belongs to the Predicate AST, while its authored label
// belongs to the editor. Every visible surface resolves UUID identity through
// this helper to the current label/name projection.

import { humanizeId } from "@/lib/domain/idSlug";
import type { SearchInputDecl } from "@/lib/domain/predicate";

export type EditorSearchInputDecl = SearchInputDecl & {
	readonly label?: string;
};

export function searchInputDisplayLabel(
	uuid: SearchInputDecl["uuid"],
	inputs: readonly EditorSearchInputDecl[],
): string {
	const input = inputs.find((candidate) => candidate.uuid === uuid);
	const fallback = humanizeId(input?.name ?? "") || "Search field";
	const label = input?.label?.trim() || fallback;
	const duplicateCount = inputs.filter(
		(candidate) =>
			(
				candidate.label?.trim() || humanizeId(candidate.name)
			).toLocaleLowerCase() === label.toLocaleLowerCase(),
	).length;

	if (duplicateCount < 2 || label === fallback) return label;
	return `${label} (${fallback})`;
}
