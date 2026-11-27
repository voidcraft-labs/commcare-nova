import type { SearchInputDef } from "@/lib/domain";
import type { searchResultDetailColumns } from "@/lib/domain/searchResultDetail";
import type { Uuid } from "@/lib/domain/uuid";

import { withSearchInputExpressionValues } from "./runtimeBindings";

type Columns = ReturnType<typeof searchResultDetailColumns>;

/** Match the query input instance. An absent or empty prompt has no node,
 * and a menu's default search sends none of its visible prompts. */
export function submittedSearchResultDetailAnswers(
	columns: Columns,
	values: ReadonlyMap<string, string>,
	defaultSearch: boolean,
	searchInputs: readonly SearchInputDef[] = [],
): ReadonlyMap<Uuid, string | null> {
	const referencedInputs = new Set(
		columns.flatMap((column) =>
			"inputUuid" in column ? [column.inputUuid] : [],
		),
	);
	const ranges = searchInputs.filter(
		(input) =>
			(input.kind === "simple" || input.kind === "advanced") &&
			input.type === "date-range" &&
			referencedInputs.has(input.uuid),
	);
	const submitted =
		ranges.length > 0 && !defaultSearch
			? withSearchInputExpressionValues(ranges, values)
			: values;
	return new Map(
		columns.flatMap((column) =>
			"inputUuid" in column
				? [
						[
							column.inputUuid,
							defaultSearch ? null : submitted.get(column.inputName) || null,
						],
					]
				: [],
		),
	);
}

/** Keep missing prompt authority separate from an offered but absent answer. */
export function searchResultDetailProjection(
	columns: Columns,
	answers: ReadonlyMap<Uuid, string | null>,
): Record<string, string> | undefined {
	if (
		columns.length === 0 ||
		columns.some(
			(column) => "inputUuid" in column && !answers.has(column.inputUuid),
		)
	)
		return;
	return Object.fromEntries(
		columns.map((column) => [
			column.columnUuid,
			"text" in column
				? column.text
				: column.prefix + (answers.get(column.inputUuid) ?? "") + column.suffix,
		]),
	);
}
