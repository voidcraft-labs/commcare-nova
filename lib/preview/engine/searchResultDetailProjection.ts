import type { searchResultDetailColumns } from "@/lib/domain/searchResultDetail";
import type { Uuid } from "@/lib/domain/uuid";

type Columns = ReturnType<typeof searchResultDetailColumns>;

/** Match the query input instance. An absent or empty text prompt has no node,
 * and a menu's default search sends none of its visible prompts. */
export function submittedSearchResultDetailAnswers(
	columns: Columns,
	values: ReadonlyMap<string, string>,
	defaultSearch: boolean,
): ReadonlyMap<Uuid, string | null> {
	return new Map(
		columns.map(({ inputUuid, inputName }) => [
			inputUuid,
			defaultSearch ? null : values.get(inputName) || null,
		]),
	);
}

/** Keep missing prompt authority separate from an offered but absent answer. */
export function searchResultDetailProjection(
	columns: Columns,
	answers: ReadonlyMap<Uuid, string | null>,
): Record<string, string> | undefined {
	if (
		columns.length === 0 ||
		columns.some(({ inputUuid }) => !answers.has(inputUuid))
	)
		return;
	return Object.fromEntries(
		columns.map(({ columnUuid, inputUuid, prefix, suffix }) => [
			columnUuid,
			prefix + (answers.get(inputUuid) ?? "") + suffix,
		]),
	);
}
