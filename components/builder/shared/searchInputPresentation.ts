// Search-input identity belongs to the Predicate AST, while its authored label
// belongs to the editor. Keep those concerns separate: type checking still
// resolves by `name`, and every visible surface asks this helper for the label.

import { humanizeId } from "@/lib/domain/idSlug";
import type { SearchInputDecl } from "@/lib/domain/predicate";

export type EditorSearchInputDecl = SearchInputDecl & {
	readonly label?: string;
};

export function searchInputDisplayLabel(
	name: string,
	inputs: readonly EditorSearchInputDecl[],
): string {
	const input = inputs.find((candidate) => candidate.name === name);
	const fallback = humanizeId(name) || "Search field";
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
